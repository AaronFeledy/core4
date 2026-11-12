import { collectProxyUrls } from "@lando/redaction/plan-values";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { mapFailures, mapStreamFailures } from "@lando/sdk/command-result";
import { ArtifactBuildError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Option, Predicate, Ref, type Schema, Stream } from "effect";
import { httpResponseDetails, redactDetails } from "./redact.ts";

export interface ContainerBuildHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly headers?: Readonly<Record<string, string>>;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly upload?: AsyncIterable<Uint8Array>;
}

export interface ContainerBuildHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ContainerBuildHttpApi {
  readonly request?: (
    request: ContainerBuildHttpRequest,
  ) => Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError>;
  readonly stream?: (
    request: ContainerBuildHttpRequest,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>;
}

export interface ContainerBuildOptions {
  readonly providerId: string;
  readonly api: ContainerBuildHttpApi;
  /** Explicit host env snapshot for heuristic secret collection. Never process.env. */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
}

type BuildRequestInput = {
  readonly request: NonNullable<ContainerBuildHttpApi["request"]>;
  readonly stream?: NonNullable<ContainerBuildHttpApi["stream"]>;
  readonly options: ContainerBuildOptions;
  readonly path: `/${string}`;
  readonly tag: string;
  readonly stdin: AsyncIterable<Uint8Array>;
  readonly secretValues: ReadonlyArray<string>;
  /** Proxy URLs whose own userinfo must be redacted alongside the host's proxy variables. */
  readonly proxyUrls?: ReadonlyArray<string>;
  readonly onOutput?: (text: string) => Effect.Effect<void, ProviderInternalError>;
};

type BuildFrameState = {
  error: string | undefined;
  digest: string | undefined;
  sinkFailed: boolean;
};

const redactBuildQuery = (value: string): string =>
  value.replace(/(buildargs=)(?:[^&\s]+)/giu, "$1[redacted]");

/** Build once per request; never construct a redactor per log/error line. */
const buildSecretsRedactor = Effect.fnUntraced(function* (
  secretValues: ReadonlyArray<string>,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  proxyUrls: ReadonlyArray<string> = [],
) {
  const redactionOptions = {
    sourceEnv,
    authoritativeTokens: secretValues.flatMap((secret) => [secret, encodeURIComponent(secret)]),
    proxyUrls: [...collectProxyUrls(sourceEnv), ...proxyUrls],
  };
  const service = yield* Effect.serviceOption(RedactionService);
  return Option.isSome(service)
    ? yield* service.value.forProfile("secrets", redactionOptions)
    : createStandaloneRedactor("secrets", redactionOptions);
});

const redactSecrets = (value: string, redactor: Redactor): string =>
  redactBuildQuery(redactor.redactString(value));

const sanitizeBuildErrorValue = (value: Schema.Json): Schema.Json => {
  if (typeof value === "string") return redactBuildQuery(value);
  if (Array.isArray(value)) return value.map(sanitizeBuildErrorValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeBuildErrorValue(entry)]),
  );
};

const sanitizeProviderError = (
  cause: ProviderUnavailableError | ProviderInternalError,
  redactor: Redactor,
): ProviderUnavailableError | ProviderInternalError => {
  const input = {
    providerId: cause.providerId,
    operation: cause.operation,
    message: redactSecrets(cause.message, redactor),
    ...(cause.details === undefined
      ? {}
      : {
          details: sanitizeBuildErrorValue(redactDetails(cause.details, redactor)),
        }),
    remediation: cause.remediation,
    ...(cause.cause === undefined ? {} : { cause: cause.cause }),
  };
  return cause instanceof ProviderInternalError
    ? new ProviderInternalError(input)
    : new ProviderUnavailableError(input);
};

const UNAVAILABLE_REMEDIATION =
  "Install or start the selected runtime provider and confirm it can perform `buildArtifact`.";

const MAX_BUILD_REASON_LENGTH = 512;

const buildFailureReason = (details: unknown, redactor: Redactor): string | undefined => {
  if (!Predicate.isObject(details) || !("body" in details)) return undefined;
  const body = details.body;
  if (typeof body !== "string" || body.trim().length === 0) return undefined;
  let reason = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (Predicate.isObject(parsed)) {
      const message = "message" in parsed ? parsed.message : undefined;
      const cause = "cause" in parsed ? parsed.cause : undefined;
      if (typeof message === "string" && message.trim().length > 0) reason = message.trim();
      else if (typeof cause === "string" && cause.trim().length > 0) reason = cause.trim();
    }
  } catch {
    // A non-JSON error body contributes its trimmed text unchanged.
  }
  const redacted = redactor.redactString(reason);
  return redacted.length > MAX_BUILD_REASON_LENGTH
    ? `${redacted.slice(0, MAX_BUILD_REASON_LENGTH - 1)}…`
    : redacted;
};

const buildHttpFailure = (
  options: ContainerBuildOptions,
  redactor: Redactor,
  status: number,
  details: unknown,
  cause?: unknown,
): ProviderUnavailableError => {
  const reason = buildFailureReason(details, redactor);
  return new ProviderUnavailableError({
    providerId: options.providerId,
    operation: "buildArtifact",
    message:
      reason === undefined
        ? `Container image build failed with HTTP ${status}.`
        : `Container image build failed with HTTP ${status}. ${reason}`,
    details: { status },
    remediation: UNAVAILABLE_REMEDIATION,
    ...(cause === undefined ? {} : { cause }),
  });
};

const mapRequestError = (
  options: ContainerBuildOptions,
  redactor: Redactor,
  cause: ProviderUnavailableError | ProviderInternalError,
): ProviderUnavailableError | ProviderInternalError =>
  cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
    ? sanitizeProviderError(cause, redactor)
    : new ProviderUnavailableError({
        providerId: options.providerId,
        operation: "buildArtifact",
        message: "Container image build request failed.",
        remediation: UNAVAILABLE_REMEDIATION,
      });

const mapBuildTransportError = (
  options: ContainerBuildOptions,
  redactor: Redactor,
  cause: ProviderUnavailableError | ProviderInternalError,
): ProviderUnavailableError | ProviderInternalError => {
  // Only an unavailable transport becomes the build's own HTTP failure; an internal error keeps its class.
  const details = cause instanceof ProviderUnavailableError ? cause.details : undefined;
  if (Predicate.isObject(details) && "status" in details && typeof details.status === "number") {
    return buildHttpFailure(options, redactor, details.status, details, cause.cause);
  }
  return mapRequestError(options, redactor, cause);
};

const artifactBuildFailure = (
  input: BuildRequestInput,
  redactor: Redactor,
  streamError: string,
): ArtifactBuildError => {
  const diagnostic = redactSecrets(streamError.trim(), redactor);
  const boundedDiagnostic = diagnostic.length > 4096 ? `${diagnostic.slice(0, 4095)}…` : diagnostic;
  const tag = redactSecrets(input.tag, redactor).slice(0, 256);
  return new ArtifactBuildError({
    providerId: input.options.providerId,
    operation: "buildArtifact",
    message: `Container image build failed: ${boundedDiagnostic}`,
    details: { message: boundedDiagnostic, tag },
    remediation: "Check the failing build step, correct it, and rebuild.",
  });
};

const emitBuildOutput = (
  text: string,
  input: BuildRequestInput,
  state: BuildFrameState,
): Effect.Effect<void, ProviderInternalError> =>
  input.onOutput === undefined
    ? Effect.void
    : input.onOutput(text).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            state.sinkFailed = true;
          }),
        ),
      );

/**
 * Handles one NDJSON frame. Its fields are independent: a frame may carry output, an error, and a digest.
 * Sink failures propagate so the caller can prefer them over later read failures.
 */
const handleBuildLine = (
  line: string,
  input: BuildRequestInput,
  state: BuildFrameState,
): Effect.Effect<void, ProviderInternalError> => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return Effect.void;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    if (cause instanceof SyntaxError) return Effect.void;
    throw cause;
  }
  if (!Predicate.isObject(parsed)) return Effect.void;

  if (state.error === undefined) {
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) state.error = parsed.error;
    else if (
      Predicate.isObject(parsed.errorDetail) &&
      typeof parsed.errorDetail.message === "string" &&
      parsed.errorDetail.message.trim().length > 0
    ) {
      state.error = parsed.errorDetail.message;
    }
  }
  if (state.digest === undefined && Predicate.isObject(parsed.aux) && typeof parsed.aux.Digest === "string") {
    state.digest = parsed.aux.Digest;
  }

  const output: string[] = [];
  if (typeof parsed.stream === "string" && parsed.stream.length > 0) output.push(parsed.stream);
  const progressDetail = "progressDetail" in parsed ? parsed.progressDetail : undefined;
  const downloadTick = Predicate.isObject(progressDetail) && typeof progressDetail.current === "number";
  if (typeof parsed.status === "string" && parsed.status.length > 0 && !downloadTick) {
    output.push(typeof parsed.id === "string" ? `${parsed.id}: ${parsed.status}\n` : `${parsed.status}\n`);
  }
  return Effect.forEach(output, (text) => emitBuildOutput(text, input, state), { discard: true });
};

type BuildRequestError = ArtifactBuildError | ProviderUnavailableError | ProviderInternalError;

export const requestContainerBuild = (
  input: BuildRequestInput,
): Effect.Effect<string | undefined, BuildRequestError> =>
  Effect.gen(function* () {
    const redactor = yield* buildSecretsRedactor(
      input.secretValues,
      input.options.sourceEnv,
      input.proxyUrls ?? [],
    );
    const state: BuildFrameState = { error: undefined, digest: undefined, sinkFailed: false };
    const headers = { "Content-Type": "application/x-tar" };

    if (input.stream !== undefined) {
      const decoder = new TextDecoder();
      const buffer = yield* Ref.make("");
      const consume = (chunk: Uint8Array) =>
        Effect.gen(function* () {
          const text = (yield* Ref.get(buffer)) + decoder.decode(chunk, { stream: true });
          const segments = text.split("\n");
          const remainder = segments.pop() ?? "";
          yield* Ref.set(buffer, remainder);
          yield* Effect.forEach(segments, (line) => handleBuildLine(line, input, state), {
            discard: true,
          });
        });
      const finish = Effect.gen(function* () {
        const text = (yield* Ref.get(buffer)) + decoder.decode();
        yield* Ref.set(buffer, "");
        yield* handleBuildLine(text, input, state);
      });

      yield* input.stream({ method: "POST", path: input.path, headers, upload: input.stdin }).pipe(
        mapStreamFailures((cause) => mapBuildTransportError(input.options, redactor, cause)),
        Stream.runForEach(consume),
        Effect.flatMap((): Effect.Effect<void, ProviderInternalError> => finish),
        mapFailures(
          (cause): BuildRequestError =>
            state.sinkFailed || state.error === undefined
              ? cause
              : artifactBuildFailure(input, redactor, state.error),
        ),
      );
    } else {
      yield* input.request({ method: "POST", path: input.path, headers, stdin: input.stdin }).pipe(
        mapFailures((cause) => mapRequestError(input.options, redactor, cause)),
        Effect.flatMap((response): Effect.Effect<void, BuildRequestError> => {
          if (response.status < 200 || response.status >= 300) {
            return Effect.fail(
              buildHttpFailure(input.options, redactor, response.status, httpResponseDetails(response)),
            );
          }
          return Effect.forEach(response.body.split("\n"), (line) => handleBuildLine(line, input, state), {
            discard: true,
          });
        }),
      );
    }

    if (state.error !== undefined) {
      return yield* Effect.fail(artifactBuildFailure(input, redactor, state.error));
    }

    return yield* input
      .request({ method: "GET", path: `/images/${encodeURIComponent(input.tag)}/json` })
      .pipe(
        mapFailures((cause) => mapRequestError(input.options, redactor, cause)),
        Effect.flatMap(
          (response): Effect.Effect<string | undefined, BuildRequestError> =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(state.digest)
              : Effect.fail(
                  new ProviderUnavailableError({
                    providerId: input.options.providerId,
                    operation: "buildArtifact",
                    message: `Built image tag ${input.tag} was not available through the container API.`,
                    details: { status: response.status, tag: input.tag },
                    remediation: UNAVAILABLE_REMEDIATION,
                  }),
                ),
        ),
      );
  });
