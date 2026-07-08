import { DateTime, Effect, Ref, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { ImagePullProgressEvent } from "@lando/sdk/events";

import type { PodmanApiClient, PodmanHttpRequest } from "./capabilities.ts";
import { redactDetails, redactString } from "./redact.ts";

const PROVIDER_ID = "lando";

const PULL_REMEDIATION =
  "Run `lando doctor` to inspect the Lando runtime, then retry the pull. Run `lando setup` if the runtime is not installed or healthy.";

/**
 * Build the Podman 6 Libpod image pull request. `pullProgress=true` asks the
 * endpoint to stream progress frames; the reference is URL-encoded so registry
 * hosts and tags survive transport intact.
 */
export const buildImagePullRequest = (reference: string): PodmanHttpRequest => ({
  method: "POST",
  path: `/libpod/images/pull?reference=${encodeURIComponent(reference)}&pullProgress=true`,
});

export type ImagePullFrame =
  | {
      readonly kind: "progress";
      readonly stream?: string;
      readonly current?: number;
      readonly total?: number;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ignore" };

const textOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const progressDetailNumber = (detail: unknown, key: "current" | "total"): number | undefined =>
  typeof detail === "object" && detail !== null
    ? numberOrUndefined((detail as Record<string, unknown>)[key])
    : undefined;

/**
 * Parse a single NDJSON pull frame into a structural result. This is pure and
 * never redacts — redaction happens at the event/error construction boundary in
 * {@link pullImage} so callers can unit-test extraction and masking separately.
 */
export const parseImagePullFrame = (line: string): ImagePullFrame => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "ignore" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "ignore" };
  const frame = parsed as Record<string, unknown>;
  const errorText = textOrUndefined(frame.error);
  if (errorText !== undefined) return { kind: "error", message: errorText };
  const streamText = textOrUndefined(frame.stream) ?? textOrUndefined(frame.status);
  const current = progressDetailNumber(frame.progressDetail, "current");
  const total = progressDetailNumber(frame.progressDetail, "total");
  if (streamText === undefined && current === undefined && total === undefined) {
    return { kind: "ignore" };
  }
  return {
    kind: "progress",
    ...(streamText === undefined ? {} : { stream: streamText }),
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
  };
};

export interface PullImageDeps {
  readonly publish: (event: ImagePullProgressEvent) => Effect.Effect<void>;
  readonly now?: () => DateTime.Utc;
}

const missingStream = (): ProviderInternalError =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation: "pullImage",
    message: "The Podman API client does not support streaming responses required for image pull.",
    remediation: PULL_REMEDIATION,
  });

const pullFailure = (reference: string, message: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "pullImage",
    message: redactString(`Podman image pull failed: ${message}`),
    details: redactDetails({ reference, error: message }),
    remediation: PULL_REMEDIATION,
  });

/**
 * Pull an image through the Podman 6 Libpod endpoint, publishing redacted
 * progress events and mapping non-200 / in-stream error frames to a typed
 * {@link ProviderUnavailableError}. Output flows only through the injected
 * `publish` seam (→ EventService → Renderer); this module never writes to
 * console or the process std streams.
 */
export const pullImage = (
  api: PodmanApiClient,
  reference: string,
  deps: PullImageDeps,
): Effect.Effect<void, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const streamFn = api.stream;
    if (streamFn === undefined) return yield* Effect.fail(missingStream());

    const now = deps.now ?? (() => DateTime.unsafeMake(Date.now()));
    const redactedReference = redactString(reference);
    const decoder = new TextDecoder();
    const buffer = yield* Ref.make("");

    const emitFrame = (line: string): Effect.Effect<void, ProviderUnavailableError> => {
      const frame = parseImagePullFrame(line);
      if (frame.kind === "ignore") return Effect.void;
      if (frame.kind === "error") return Effect.fail(pullFailure(reference, frame.message));
      return deps.publish(
        ImagePullProgressEvent.make({
          eventName: "image-pull-progress" as const,
          reference: redactedReference,
          ...(frame.stream === undefined ? {} : { stream: redactString(frame.stream) }),
          ...(frame.current === undefined ? {} : { current: frame.current }),
          ...(frame.total === undefined ? {} : { total: frame.total }),
          timestamp: now(),
        }),
      );
    };

    yield* streamFn(buildImagePullRequest(reference)).pipe(
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

    const tail = (yield* Ref.get(buffer)) + decoder.decode();
    yield* emitFrame(tail);
  });
