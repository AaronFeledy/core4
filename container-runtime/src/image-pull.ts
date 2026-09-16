import { DateTime, Effect, Ref, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { ImagePullProgressEvent } from "@lando/sdk/events";

import type { PullDialect } from "./dialect.ts";
import type { EngineHttpApi, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { redactDetails, redactString, withApiReason } from "./redact.ts";

const REGISTRY_AUTH_REMEDIATION =
  "The container engine may be using stale registry credentials from ${XDG_RUNTIME_DIR}/containers/auth.json, $REGISTRY_AUTH_FILE, $DOCKER_CONFIG, or ~/.docker/config.json. Run `podman logout --all` or `docker logout`, or remove the stale `auths` entry for the affected registry, then retry the pull.";

const REGISTRY_AUTH_FAILURE_SIGNATURES = [
  "unauthorized",
  "authentication required",
  "401",
  "unable to retrieve auth token",
  "invalid username/password",
] as const;

export type PullFailureKind = "registry-auth" | "generic";
export type PullFailureSource = "stream-frame";
export type PullFailureSignature =
  | "toomanyrequests"
  | "denied"
  | "manifest-unknown"
  | "name-unknown"
  | "no-such-host"
  | "connection-refused"
  | "timeout"
  | "tls"
  | "unknown";

const PULL_FAILURE_SIGNATURES: ReadonlyArray<readonly [signature: PullFailureSignature, pattern: RegExp]> = [
  ["toomanyrequests", /\btoomanyrequests\b/iu],
  ["denied", /\bdenied\b/iu],
  ["manifest-unknown", /(?:^|[^a-z0-9])manifest[ _-]unknown(?:$|[^a-z0-9])/iu],
  ["name-unknown", /(?:^|[^a-z0-9])name[ _-]unknown(?:$|[^a-z0-9])/iu],
  ["no-such-host", /\bno such host\b/iu],
  ["connection-refused", /\bconnection refused\b/iu],
  ["timeout", /\b(?:i\/o timeout|timed out|timeout)\b/iu],
  ["tls", /\b(?:tls|x509)\b/iu],
];

export type ImagePullFrame =
  | {
      readonly kind: "progress";
      readonly stream?: string;
      readonly current?: number;
      readonly total?: number;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly source: PullFailureSource;
      readonly signature: PullFailureSignature;
    }
  | { readonly kind: "ignore" };

export interface PullImageOptions<E = never> {
  readonly ctx: ProviderErrorContext;
  readonly dialect: PullDialect;
  readonly publish?: (event: ImagePullProgressEvent) => Effect.Effect<void, E>;
}

export type PullImageDeps<E = never> = PullImageOptions<E>;

export interface PulledImage {
  readonly ref: string;
  readonly digest?: string;
}

export const classifyPullFailure = (message: string): PullFailureKind => {
  const normalized = message.toLowerCase();
  return REGISTRY_AUTH_FAILURE_SIGNATURES.some((signature) => normalized.includes(signature))
    ? "registry-auth"
    : "generic";
};

export const classifyPullFailureSignature = (message: string): PullFailureSignature =>
  PULL_FAILURE_SIGNATURES.find(([, pattern]) => pattern.test(message))?.[0] ?? "unknown";

export const buildImagePullRequest = (reference: string, dialect: PullDialect) => dialect.request(reference);

const textOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const progressDetailNumber = (detail: unknown, key: "current" | "total"): number | undefined => {
  if (typeof detail !== "object" || detail === null || !(key in detail)) return undefined;
  return numberOrUndefined(Reflect.get(detail, key));
};

export const parseImagePullFrame = (line: string, dialect: PullDialect): ImagePullFrame => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "ignore" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "ignore" };
  const errorText = dialect.frameError(parsed);
  if (errorText !== undefined)
    return {
      kind: "error",
      message: errorText,
      source: "stream-frame",
      signature: classifyPullFailureSignature(errorText),
    };
  const streamText = textOrUndefined("stream" in parsed ? parsed.stream : undefined);
  const statusText = textOrUndefined("status" in parsed ? parsed.status : undefined);
  const progressDetail = "progressDetail" in parsed ? parsed.progressDetail : undefined;
  const current = progressDetailNumber(progressDetail, "current");
  const total = progressDetailNumber(progressDetail, "total");
  const stream = streamText ?? statusText;
  if (stream === undefined && current === undefined && total === undefined) return { kind: "ignore" };
  return {
    kind: "progress",
    ...(stream === undefined ? {} : { stream }),
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
  };
};

type PullFailureInput = {
  readonly ctx: ProviderErrorContext;
  readonly reference: string;
  readonly message: string;
  readonly source?: PullFailureSource;
  readonly signature?: PullFailureSignature;
  readonly details?: unknown;
  readonly cause?: unknown;
};

const pullFailureFields = (input: PullFailureInput) => {
  const failureKind = classifyPullFailure(input.message);
  return {
    providerId: input.ctx.providerId,
    operation: "pullArtifact",
    message: redactString(`Container image pull failed: ${input.message}`),
    details: redactDetails(
      input.source === undefined
        ? {
            reference: input.reference,
            error: input.message,
            failureKind,
            ...(input.details === undefined ? {} : { details: input.details }),
          }
        : {
            failureKind,
            source: input.source,
            ...(input.signature === undefined ? {} : { signature: input.signature }),
          },
    ),
    remediation: failureKind === "registry-auth" ? REGISTRY_AUTH_REMEDIATION : input.ctx.remediation,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
};

const pullFailure = (input: PullFailureInput): ProviderUnavailableError =>
  new ProviderUnavailableError(pullFailureFields(input));

const httpStatusOf = (details: unknown): number | undefined => {
  if (typeof details !== "object" || details === null || !("status" in details)) return undefined;
  return typeof details.status === "number" ? details.status : undefined;
};

/**
 * The stream transport rejects non-2xx responses before the pull loop sees them. Re-tag
 * those as pull failures so the status and engine reason reach `classifyPullFailure`
 * (HTTP 401 → registry-auth remediation) exactly like the buffered path. Connect and
 * parse failures carry no status and pass through untouched.
 */
const pullFailureFromTransport = (
  ctx: ProviderErrorContext,
  reference: string,
  error: ProviderUnavailableError | ProviderInternalError,
): ProviderUnavailableError | ProviderInternalError => {
  const status = httpStatusOf(error.details);
  const input = {
    ctx,
    reference,
    message: status === undefined ? error.message : withApiReason(`HTTP ${status}.`, error.details),
    ...(status === undefined ? {} : { details: error.details }),
    cause: error,
  };
  return error instanceof ProviderInternalError
    ? new ProviderInternalError(pullFailureFields(input))
    : pullFailure(input);
};

const parseResponseJson = (
  response: EngineHttpResponse,
  ctx: ProviderErrorContext,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: (): unknown => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: ctx.providerId,
        operation: "pullArtifact",
        message: "Container engine API returned malformed JSON.",
        details: redactDetails(response),
        remediation: ctx.remediation,
        cause,
      }),
  });

export const pullImage = <E = never>(
  api: EngineHttpApi,
  reference: string,
  options: PullImageOptions<E>,
): Effect.Effect<PulledImage, ProviderUnavailableError | ProviderInternalError | E> =>
  Effect.gen(function* () {
    const emitFrame = (line: string): Effect.Effect<void, ProviderUnavailableError | E> => {
      const frame = parseImagePullFrame(line, options.dialect);
      switch (frame.kind) {
        case "ignore":
          return Effect.void;
        case "error":
          return Effect.fail(
            pullFailure({
              ctx: options.ctx,
              reference,
              message: frame.message,
              source: frame.source,
              signature: frame.signature,
            }),
          );
        case "progress":
          return options.publish === undefined
            ? Effect.void
            : options.publish(
                ImagePullProgressEvent.make({
                  eventName: "image-pull-progress" as const,
                  reference: redactString(reference),
                  ...(frame.stream === undefined ? {} : { stream: redactString(frame.stream) }),
                  ...(frame.current === undefined ? {} : { current: frame.current }),
                  ...(frame.total === undefined ? {} : { total: frame.total }),
                  timestamp: DateTime.unsafeMake(Date.now()),
                }),
              );
      }
    };

    if (api.stream !== undefined) {
      const decoder = new TextDecoder();
      const buffer = yield* Ref.make("");
      yield* api.stream(buildImagePullRequest(reference, options.dialect)).pipe(
        Stream.mapError((error) => pullFailureFromTransport(options.ctx, reference, error)),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const text = (yield* Ref.get(buffer)) + decoder.decode(chunk, { stream: true });
            const segments = text.split("\n");
            const remainder = segments.pop() ?? "";
            yield* Ref.set(buffer, remainder);
            yield* Effect.forEach(segments, emitFrame, { discard: true });
          }),
        ),
      );
      yield* emitFrame((yield* Ref.get(buffer)) + decoder.decode());
    } else if (api.request !== undefined) {
      const response = yield* api.request(buildImagePullRequest(reference, options.dialect));
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          pullFailure({
            ctx: options.ctx,
            reference,
            message: withApiReason(`HTTP ${response.status}.`, response),
            details: response,
          }),
        );
      }
      yield* Effect.forEach(response.body.split("\n"), emitFrame, { discard: true });
    } else {
      return yield* Effect.fail(
        missingApi(
          options.ctx,
          "pullArtifact",
          `provider-${options.ctx.providerId} pullArtifact requires a container engine API client.`,
        ),
      );
    }

    const inspect = options.dialect.inspect;
    if (inspect === undefined) return { ref: reference };
    const request = api.request;
    if (request === undefined) {
      return yield* Effect.fail(
        missingApi(
          options.ctx,
          "pullArtifact",
          `provider-${options.ctx.providerId} pullArtifact inspect requires a container engine API client.`,
        ),
      );
    }
    const response = yield* request(inspect.request(reference));
    if (response.status !== 200) {
      return yield* Effect.fail(
        pullFailure({
          ctx: options.ctx,
          reference,
          message: `post-pull inspect HTTP ${response.status}.`,
          details: response,
        }),
      );
    }
    const decoded = yield* parseResponseJson(response, options.ctx);
    const digest = inspect.decodeDigest(decoded);
    return { ref: reference, ...(digest === undefined ? {} : { digest }) };
  });
