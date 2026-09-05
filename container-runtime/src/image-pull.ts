import { DateTime, Effect, Ref, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { ImagePullProgressEvent } from "@lando/sdk/events";

import type { PullDialect } from "./dialect.ts";
import type { EngineHttpApi, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { redactDetails, redactString } from "./redact.ts";

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

export type ImagePullFrame =
  | {
      readonly kind: "progress";
      readonly stream?: string;
      readonly current?: number;
      readonly total?: number;
    }
  | { readonly kind: "error"; readonly message: string }
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
  if (errorText !== undefined) return { kind: "error", message: errorText };
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

const pullFailure = (
  ctx: ProviderErrorContext,
  reference: string,
  message: string,
  details?: unknown,
): ProviderUnavailableError => {
  const failureKind = classifyPullFailure(message);
  return new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "pullImage",
    message: redactString(`Container image pull failed: ${message}`),
    details: redactDetails({
      reference,
      error: message,
      failureKind,
      ...(details === undefined ? {} : { details }),
    }),
    remediation: failureKind === "registry-auth" ? REGISTRY_AUTH_REMEDIATION : ctx.remediation,
  });
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
        operation: "pullImage",
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
          return Effect.fail(pullFailure(options.ctx, reference, frame.message));
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
        return yield* Effect.fail(pullFailure(options.ctx, reference, `HTTP ${response.status}.`, response));
      }
      yield* Effect.forEach(response.body.split("\n"), emitFrame, { discard: true });
    } else {
      return yield* Effect.fail(
        missingApi(
          options.ctx,
          "pullImage",
          `provider-${options.ctx.providerId} pullImage requires a container engine API client.`,
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
          "pullImage",
          `provider-${options.ctx.providerId} pullImage inspect requires a container engine API client.`,
        ),
      );
    }
    const response = yield* request(inspect.request(reference));
    if (response.status !== 200) {
      return yield* Effect.fail(
        pullFailure(options.ctx, reference, `post-pull inspect HTTP ${response.status}.`, response),
      );
    }
    const decoded = yield* parseResponseJson(response, options.ctx);
    const digest = inspect.decodeDigest(decoded);
    return { ref: reference, ...(digest === undefined ? {} : { digest }) };
  });
