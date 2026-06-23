/**
 * `DownloaderLive` — the verified-artifact specialization layered over the
 * core-private `HttpClient`.
 *
 * Every byte of egress is issued through `HttpClient.stream`; this service never
 * calls `fetch` and never resolves proxy/CA itself, so overriding `HttpClient`
 * governs downloads too. On top of that it adds checksum/size verification,
 * atomic temp-file persistence, cache/offline short-circuiting, and scheme
 * gating.
 *
 * Lifecycle events are published through a redacted event seam in the `Live`
 * layer closure; `EventService` is optional via `Effect.serviceOption`. Payloads
 * use scheme+host `urlOrigin` only, with free-string fields passed through the
 * request's `redactionTokens` redactor.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

import { Cause, type Context, DateTime, Effect, type Exit, Layer, Option, Ref, Stream } from "effect";

import {
  DownloadChecksumError,
  DownloadFetchError,
  DownloadOfflineError,
  DownloadPersistError,
  DownloadSizeMismatchError,
  DownloadSourceForbiddenError,
} from "@lando/sdk/errors";
import { DownloadProgressEvent, PostDownloadEvent, PreDownloadEvent } from "@lando/sdk/events";
import type { DownloadRequest, DownloadResult, DownloaderCapabilities } from "@lando/sdk/schema";
import { createSecretRedactor } from "@lando/sdk/secrets";
import { Downloader, type DownloaderShape, EventService, type LandoEvent } from "@lando/sdk/services";
import {
  type VerifiedStreamError,
  collectVerifiedStream,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";

import { HttpClient } from "../http-client/service.ts";

const CAPABILITIES: DownloaderCapabilities = {
  schemes: ["https", "file"],
  memoryDownload: true,
  cacheAware: true,
  offline: true,
  mirror: false,
};

/** Redacted scheme+host origin only — never userinfo, path, or query. */
const urlOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

const statusError = (status: number, origin: string): DownloadFetchError | undefined =>
  status >= 200 && status < 300
    ? undefined
    : new DownloadFetchError({
        message: `The download request failed with HTTP status ${status}.`,
        urlOrigin: origin,
        status,
      });

const validateSource = (request: DownloadRequest): DownloadSourceForbiddenError | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return new DownloadSourceForbiddenError({
      message: "The download URL is not a valid absolute URL.",
      url: request.url,
      reason: "scheme",
    });
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "file:") {
    if (request.allowFileSource === true) return undefined;
    return new DownloadSourceForbiddenError({
      message: "file:// sources are rejected unless the request explicitly allows local sources.",
      url: request.url,
      reason: "file-source",
    });
  }
  return new DownloadSourceForbiddenError({
    message: `The scheme ${parsed.protocol} is not allowed; https:// is the only production scheme.`,
    url: request.url,
    reason: "scheme",
  });
};

const validateDestinationFilename = (filename: string): DownloadSourceForbiddenError | undefined => {
  if (
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".."
  ) {
    return new DownloadSourceForbiddenError({
      message: "The destination filename must be a single path segment within the target directory.",
      reason: "destination-escape",
    });
  }
  return undefined;
};

/** Hash an existing destination file, or `undefined` when it is absent/unreadable. */
const hashExistingFile = (
  path: string,
): Effect.Effect<{ readonly sha256: string; readonly sizeBytes: number } | undefined> =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const stream = createReadStream(path);
        stream.on("data", (chunk: string | Buffer) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          hash.update(buf);
          sizeBytes += buf.length;
        });
        stream.on("end", () => resolve({ sha256: hash.digest("hex"), sizeBytes }));
        stream.on("error", () => resolve(undefined));
      }),
  );

const mapVerifiedError = (error: VerifiedStreamError, origin: string): DownloadError => {
  switch (error.reason) {
    case "checksum":
      return new DownloadChecksumError({
        message: error.message,
        urlOrigin: origin,
        expectedSha256: error.expectedSha256 ?? "",
        actualSha256: error.actualSha256 ?? "",
        ...(error.actualSizeBytes === undefined ? {} : { sizeBytes: error.actualSizeBytes }),
      });
    case "size":
      return new DownloadSizeMismatchError({
        message: error.message,
        urlOrigin: origin,
        expectedSizeBytes: error.expectedSizeBytes ?? 0,
        actualSizeBytes: error.actualSizeBytes ?? 0,
      });
    case "persist":
      return new DownloadPersistError({
        message: error.message,
        operation: "write",
        ...(error.cause === undefined ? {} : { cause: error.cause }),
      });
  }
};

type DownloadError =
  | DownloadFetchError
  | DownloadChecksumError
  | DownloadSizeMismatchError
  | DownloadPersistError
  | DownloadOfflineError
  | DownloadSourceForbiddenError;

// ----- Event seam (redact -> publish) -------------------------------------

/**
 * The redacted-event seam the downloader publishes its lifecycle scope through.
 * `redactText` masks secret values out of every free-string payload field
 * BEFORE construction; `publish` forwards the content-free event to the
 * `EventService` (failures swallowed — events are observational only). Both deps
 * live in the `Live` layer closure so the frozen SDK tag is unwidened.
 */
export interface DownloaderEvents {
  readonly redactText: (text: string) => string;
  readonly publish: (event: LandoEvent) => Effect.Effect<void>;
}

const noopDownloaderEvents: DownloaderEvents = {
  redactText: (text) => text,
  publish: () => Effect.void,
};

/** Build a redacted, fail-open event seam from an optional `EventService`. */
export const makeLiveDownloaderEvents = (
  eventService: Option.Option<Context.Tag.Service<typeof EventService>>,
): DownloaderEvents => {
  const { redact } = createSecretRedactor([]);
  const publish: DownloaderEvents["publish"] = Option.isSome(eventService)
    ? (event) => eventService.value.publish(event).pipe(Effect.catchAllCause(() => Effect.void))
    : () => Effect.void;
  return { redactText: redact, publish };
};

/** Controlled, content-free failure summary — never raw URLs, query, or causes. */
const failureDetailForError = (error: DownloadError): string => {
  switch (error._tag) {
    case "DownloadFetchError":
      return error.status === undefined ? "fetch-failed" : `fetch-failed status=${error.status}`;
    case "DownloadChecksumError":
      return "checksum-mismatch";
    case "DownloadSizeMismatchError":
      return "size-mismatch";
    case "DownloadPersistError":
      return `persist-failed operation=${error.operation}`;
    case "DownloadOfflineError":
      return "offline-cache-miss";
    case "DownloadSourceForbiddenError":
      return `source-forbidden reason=${error.reason}`;
  }
};

const isDownloadError = (value: unknown): value is DownloadError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof (value as { _tag?: unknown })._tag === "string" &&
  (value as { _tag: string })._tag.startsWith("Download");

/** Map a failed/interrupted exit cause to a controlled, content-free detail. */
const failureDetailFromExitCause = (cause: Cause.Cause<DownloadError>): string => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined && isDownloadError(failure)) return failureDetailForError(failure);
  if (Cause.isInterrupted(cause)) return "interrupted";
  return "error";
};

interface PostEventInput {
  readonly origin: string;
  readonly callerId: string | undefined;
  readonly outcome: "success" | "failure";
  readonly fromCache: boolean;
  readonly bytesDownloaded: number | undefined;
  readonly sha256: string | undefined;
  readonly durationMs: number;
  readonly failureDetail: string | undefined;
  readonly redact: (text: string) => string;
}

// ----- Service factory ----------------------------------------------------

/**
 * Build a `Downloader` service over a resolved `HttpClient` and event seam. The
 * `events` seam defaults to a no-op so library callers without an
 * `EventService` keep working byte-for-byte.
 */
export const makeDownloaderService = (
  http: Context.Tag.Service<typeof HttpClient>,
  events: DownloaderEvents = noopDownloaderEvents,
): DownloaderShape => ({
  id: "core-downloader",
  capabilities: CAPABILITIES,
  download: (request) => {
    const origin = urlOrigin(request.url);
    const { redact: tokenRedact } = createSecretRedactor(request.redactionTokens ?? []);
    const redact = (text: string): string => tokenRedact(events.redactText(text));
    const callerId = request.callerId;

    const preEvent = (): LandoEvent =>
      PreDownloadEvent.make({
        eventName: "pre-download" as const,
        urlOrigin: origin,
        ...(callerId === undefined ? {} : { callerId: redact(callerId) }),
        ...(request.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: request.expectedSizeBytes }),
        timestamp: DateTime.unsafeMake(Date.now()),
      });

    const progressEvent = (bytesDownloaded: number): LandoEvent =>
      DownloadProgressEvent.make({
        eventName: "download-progress" as const,
        urlOrigin: origin,
        ...(callerId === undefined ? {} : { callerId: redact(callerId) }),
        bytesDownloaded,
        ...(request.expectedSizeBytes === undefined ? {} : { totalBytes: request.expectedSizeBytes }),
        timestamp: DateTime.unsafeMake(Date.now()),
      });

    const postEvent = (input: PostEventInput): LandoEvent =>
      PostDownloadEvent.make({
        eventName: "post-download" as const,
        urlOrigin: input.origin,
        ...(input.callerId === undefined ? {} : { callerId: input.redact(input.callerId) }),
        ...(input.bytesDownloaded === undefined ? {} : { bytesDownloaded: input.bytesDownloaded }),
        fromCache: input.fromCache,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        durationMs: input.durationMs,
        outcome: input.outcome,
        ...(input.failureDetail === undefined ? {} : { failureDetail: input.redact(input.failureDetail) }),
        timestamp: DateTime.unsafeMake(Date.now()),
      });

    return Effect.gen(function* () {
      const startedAt = Date.now();
      const progress = yield* Ref.make(0);
      yield* events.publish(preEvent());

      const tapProgress = <E>(body: Stream.Stream<Uint8Array, E>): Stream.Stream<Uint8Array, E> =>
        body.pipe(
          Stream.tap((chunk) =>
            Ref.updateAndGet(progress, (total) => total + chunk.length).pipe(
              Effect.flatMap((total) => events.publish(progressEvent(total))),
            ),
          ),
        );

      const core = Effect.gen(function* () {
        const sourceError = validateSource(request);
        if (sourceError !== undefined) return yield* Effect.fail(sourceError);

        if (request.destination.kind === "file") {
          const { directory, filename } = request.destination;
          const destinationError = validateDestinationFilename(filename);
          if (destinationError !== undefined) return yield* Effect.fail(destinationError);
          const destinationPath = join(directory, filename);

          if (request.expectedSha256 !== undefined) {
            const existing = yield* hashExistingFile(destinationPath);
            if (
              existing !== undefined &&
              existing.sha256 === request.expectedSha256 &&
              (request.expectedSizeBytes === undefined || existing.sizeBytes === request.expectedSizeBytes)
            ) {
              return {
                url: request.url,
                kind: "file",
                path: destinationPath,
                sha256: existing.sha256,
                sizeBytes: existing.sizeBytes,
                fromCache: true,
              } satisfies DownloadResult;
            }
          }

          if (request.offline === true) {
            return yield* Effect.fail(
              new DownloadOfflineError({
                message: "Offline mode is enabled and the artifact is not present in the verified cache.",
                urlOrigin: origin,
              }),
            );
          }

          const response = yield* http.stream({
            url: request.url,
            allowFileSource: request.allowFileSource ?? false,
          });
          const httpError = statusError(response.status, origin);
          if (httpError !== undefined) return yield* Effect.fail(httpError);
          const result = yield* persistVerifiedStream({
            body: tapProgress(response.body),
            destinationPath,
            expectedSha256: request.expectedSha256,
            expectedSizeBytes: request.expectedSizeBytes,
          });
          return {
            url: request.url,
            kind: "file",
            path: destinationPath,
            sha256: result.sha256,
            sizeBytes: result.sizeBytes,
            fromCache: false,
          } satisfies DownloadResult;
        }

        if (request.offline === true) {
          return yield* Effect.fail(
            new DownloadOfflineError({
              message: "Offline mode is enabled and the artifact is not present in the verified cache.",
              urlOrigin: origin,
            }),
          );
        }

        const response = yield* http.stream({
          url: request.url,
          allowFileSource: request.allowFileSource ?? false,
        });
        const httpError = statusError(response.status, origin);
        if (httpError !== undefined) return yield* Effect.fail(httpError);
        const result = yield* collectVerifiedStream({
          body: tapProgress(response.body),
          expectedSha256: request.expectedSha256,
          expectedSizeBytes: request.expectedSizeBytes,
        });
        return {
          url: request.url,
          kind: "memory",
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          fromCache: false,
        } satisfies DownloadResult;
      }).pipe(
        Effect.catchTags({
          HttpStreamError: (error) =>
            Effect.fail(
              new DownloadFetchError({
                message: error.message,
                urlOrigin: origin,
                ...(error.status === undefined ? {} : { status: error.status }),
                ...(error.cause === undefined ? {} : { cause: error.cause }),
              }),
            ),
          VerifiedStreamError: (error) => Effect.fail(mapVerifiedError(error, origin)),
        }),
      );

      const publishPost = (exit: Exit.Exit<DownloadResult, DownloadError>): Effect.Effect<void> =>
        Effect.gen(function* () {
          const bytes = yield* Ref.get(progress);
          const durationMs = Date.now() - startedAt;
          if (exit._tag === "Success") {
            const value = exit.value;
            yield* events.publish(
              postEvent({
                origin,
                callerId,
                outcome: "success",
                fromCache: value.fromCache,
                bytesDownloaded: value.fromCache ? 0 : value.sizeBytes,
                sha256: value.sha256,
                durationMs,
                failureDetail: undefined,
                redact,
              }),
            );
            return;
          }
          yield* events.publish(
            postEvent({
              origin,
              callerId,
              outcome: "failure",
              fromCache: false,
              bytesDownloaded: bytes > 0 ? bytes : undefined,
              sha256: undefined,
              durationMs,
              failureDetail: failureDetailFromExitCause(exit.cause),
              redact,
            }),
          );
        });

      return yield* core.pipe(Effect.onExit(publishPost));
    });
  },
});

export const DownloaderLive: Layer.Layer<Downloader, never, HttpClient> = Layer.effect(
  Downloader,
  Effect.gen(function* () {
    const http = yield* HttpClient;
    const eventService = yield* Effect.serviceOption(EventService);
    return makeDownloaderService(http, makeLiveDownloaderEvents(eventService));
  }),
);
