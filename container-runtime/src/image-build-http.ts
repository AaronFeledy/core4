import { Effect, Option, Predicate } from "effect";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { ArtifactBuildError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { parseNdjsonLines } from "./engine-json.ts";

export interface ContainerBuildHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly headers?: Readonly<Record<string, string>>;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface ContainerBuildHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ContainerBuildHttpApi {
  readonly request?: (
    request: ContainerBuildHttpRequest,
  ) => Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError>;
}

export interface ContainerBuildOptions {
  readonly providerId: string;
  readonly api: ContainerBuildHttpApi;
  /** Explicit host env snapshot for heuristic secret collection. Never process.env. */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
}

type BuildRequestInput = {
  readonly request: NonNullable<ContainerBuildHttpApi["request"]>;
  readonly options: ContainerBuildOptions;
  readonly path: `/${string}`;
  readonly tag: string;
  readonly stdin: AsyncIterable<Uint8Array>;
  readonly secretValues: ReadonlyArray<string>;
};

const redactBuildQuery = (value: string): string =>
  value.replace(/(buildargs=)(?:[^&\s]+)/giu, "$1[redacted]");

/** Build once per request; never construct a redactor per log/error line. */
const buildSecretsRedactor = Effect.fnUntraced(function* (
  secretValues: ReadonlyArray<string>,
  sourceEnv: Readonly<Record<string, string | undefined>>,
) {
  const redactionOptions = {
    sourceEnv,
    authoritativeTokens: secretValues.flatMap((secret) => [secret, encodeURIComponent(secret)]),
  };
  const service = yield* Effect.serviceOption(RedactionService);
  return Option.isSome(service)
    ? yield* service.value.forProfile("secrets", redactionOptions)
    : createStandaloneRedactor("secrets", redactionOptions);
});

const redactSecrets = (value: string, redactor: Redactor): string =>
  redactBuildQuery(redactor.redactString(value));

const sanitizeBuildErrorValue = (value: unknown, redactor: Redactor): unknown => {
  if (typeof value === "string") return redactSecrets(value, redactor);
  if (Array.isArray(value)) return value.map((entry) => sanitizeBuildErrorValue(entry, redactor));
  if (!Predicate.isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeBuildErrorValue(entry, redactor)]),
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
    details: cause.details === undefined ? undefined : sanitizeBuildErrorValue(cause.details, redactor),
    remediation: cause.remediation,
  };
  return cause instanceof ProviderInternalError
    ? new ProviderInternalError(input)
    : new ProviderUnavailableError(input);
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
        remediation:
          "Install or start the selected runtime provider and confirm it can perform `buildArtifact`.",
      });

const buildStreamError = (body: string): string | undefined => {
  for (const parsed of parseNdjsonLines(body, { separator: "\n", onInvalidLine: "rethrow-non-syntax" })) {
    if (!Predicate.isObject(parsed)) continue;
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) return parsed.error;
    if (
      Predicate.isObject(parsed.errorDetail) &&
      typeof parsed.errorDetail.message === "string" &&
      parsed.errorDetail.message.trim().length > 0
    ) {
      return parsed.errorDetail.message;
    }
  }
  return undefined;
};

const parseDigest = (body: string): string | undefined => {
  for (const parsed of parseNdjsonLines(body, { separator: "\n", onInvalidLine: "rethrow-non-syntax" })) {
    if (
      Predicate.isObject(parsed) &&
      Predicate.isObject(parsed.aux) &&
      typeof parsed.aux.Digest === "string"
    ) {
      return parsed.aux.Digest;
    }
  }
  return undefined;
};

export const requestContainerBuild = (
  input: BuildRequestInput,
): Effect.Effect<string | undefined, ArtifactBuildError | ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const redactor = yield* buildSecretsRedactor(input.secretValues, input.options.sourceEnv);
    return yield* input
      .request({
        method: "POST",
        path: input.path,
        headers: { "Content-Type": "application/x-tar" },
        stdin: input.stdin,
      })
      .pipe(
        Effect.mapError((cause) => mapRequestError(input.options, redactor, cause)),
        Effect.flatMap(
          (response): Effect.Effect<string | undefined, ProviderUnavailableError | ArtifactBuildError> => {
            if (response.status < 200 || response.status >= 300) {
              return Effect.fail(
                new ProviderUnavailableError({
                  providerId: input.options.providerId,
                  operation: "buildArtifact",
                  message: `Container image build failed with HTTP ${response.status}.`,
                  details: { status: response.status },
                  remediation:
                    "Install or start the selected runtime provider and confirm it can perform `buildArtifact`.",
                }),
              );
            }
            const streamError = buildStreamError(response.body);
            if (streamError === undefined) return Effect.succeed(parseDigest(response.body));
            const diagnostic = redactSecrets(streamError, redactor);
            const boundedDiagnostic = diagnostic.length > 4096 ? `${diagnostic.slice(0, 4095)}…` : diagnostic;
            const tag = redactSecrets(input.tag, redactor).slice(0, 256);
            return Effect.fail(
              new ArtifactBuildError({
                providerId: input.options.providerId,
                operation: "buildArtifact",
                message: `Container image build failed: ${boundedDiagnostic}`,
                details: { message: boundedDiagnostic, tag },
                remediation: `Check the failing Containerfile step for image ${tag}, correct it, and rebuild.`,
              }),
            );
          },
        ),
        Effect.flatMap((digest) =>
          input.request({ method: "GET", path: `/images/${encodeURIComponent(input.tag)}/json` }).pipe(
            Effect.mapError((cause) => mapRequestError(input.options, redactor, cause)),
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.succeed(digest)
                : Effect.fail(
                    new ProviderUnavailableError({
                      providerId: input.options.providerId,
                      operation: "buildArtifact",
                      message: `Built image tag ${input.tag} was not available through the container API.`,
                      details: { status: response.status, tag: input.tag },
                      remediation:
                        "Install or start the selected runtime provider and confirm it can perform `buildArtifact`.",
                    }),
                  ),
            ),
          ),
        ),
      );
  });
