/**
 * Core download body: cache, offline, stream, verify, and lifecycle events.
 */
import { join } from "node:path";

import { Clock, DateTime, Effect, type Exit, Ref, Stream } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";

import { DownloadOfflineError } from "@lando/sdk/errors";
import { DownloadProgressEvent, PostDownloadEvent, PreDownloadEvent } from "@lando/sdk/events";
import type { DownloadRequest, DownloadResult, DownloaderCapabilities } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { DownloaderShape, LandoEvent } from "@lando/sdk/services";
import { collectVerifiedStream, persistVerifiedStream } from "@lando/sdk/verified-stream";

import { tryCacheHit } from "./downloader-cache.ts";
import {
  type DownloadError,
  mapHttpClientError,
  mapVerifiedError,
  statusError,
} from "./downloader-errors.ts";
import {
  type DownloaderEvents,
  failureDetailFromExitCause,
  noopDownloaderEvents,
} from "./downloader-events.ts";
import { urlOrigin, validateDestinationFilename, validateSource } from "./downloader-validate.ts";
import { RequestPolicy, type RequestPolicyShape } from "./policy.ts";

const CAPABILITIES: DownloaderCapabilities = {
  schemes: ["https", "file"],
  memoryDownload: true,
  cacheAware: true,
  offline: true,
  mirror: false,
};

/** Build the fiber-local egress policy for one download request. */
const requestPolicyFor = (request: DownloadRequest): RequestPolicyShape => ({
  onBehalfOf: "downloader",
  ...(request.callerId === undefined ? {} : { callerId: request.callerId }),
  ...(request.redactionTokens === undefined ? {} : { redactionTokens: request.redactionTokens }),
  ...(request.allowFileSource === undefined ? {} : { allowFileSource: request.allowFileSource }),
  ...(request.offline === undefined ? {} : { offline: request.offline }),
});

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
  readonly timestamp: DateTime.Utc;
}

/**
 * Build a `Downloader` service over a resolved Effect `HttpClient` and event
 * seam. The `events` seam defaults to a no-op so library callers without an
 * `EventService` keep working.
 */
export const makeDownloaderService = (
  http: HttpClient.HttpClient,
  events: DownloaderEvents = noopDownloaderEvents,
): DownloaderShape => ({
  id: "core-downloader",
  capabilities: CAPABILITIES,
  download: Effect.fn("Downloader.download")(function* (request: DownloadRequest) {
    const origin = urlOrigin(request.url);
    const tokenRedact = createRedactor("secrets", { values: request.redactionTokens ?? [] }).redactString;
    const redact = (text: string): string => tokenRedact(events.redactText(text));
    const callerId = request.callerId;
    const policy = requestPolicyFor(request);

    const preEvent = (timestamp: DateTime.Utc): LandoEvent =>
      PreDownloadEvent.make({
        eventName: "pre-download" as const,
        urlOrigin: origin,
        ...(callerId === undefined ? {} : { callerId: redact(callerId) }),
        ...(request.expectedSizeBytes === undefined ? {} : { expectedSizeBytes: request.expectedSizeBytes }),
        timestamp,
      });

    const progressEvent = (bytesDownloaded: number, timestamp: DateTime.Utc): LandoEvent =>
      DownloadProgressEvent.make({
        eventName: "download-progress" as const,
        urlOrigin: origin,
        ...(callerId === undefined ? {} : { callerId: redact(callerId) }),
        bytesDownloaded,
        ...(request.expectedSizeBytes === undefined ? {} : { totalBytes: request.expectedSizeBytes }),
        timestamp,
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
        timestamp: input.timestamp,
      });

    const startedAt = yield* Clock.currentTimeMillis;
    const progress = yield* Ref.make(0);
    yield* events.publish(preEvent(yield* DateTime.now));

    const tapProgress = <E, R>(body: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
      body.pipe(
        Stream.tap((chunk) =>
          Ref.updateAndGet(progress, (total) => total + chunk.length).pipe(
            Effect.flatMap((total) =>
              DateTime.now.pipe(
                Effect.flatMap((timestamp) => events.publish(progressEvent(total, timestamp))),
              ),
            ),
          ),
        ),
      );

    const fetchBody = Effect.fnUntraced(function* () {
      const response = yield* http.get(request.url).pipe(
        Effect.provideService(RequestPolicy, policy),
        Effect.mapError((error: HttpClientError.HttpClientError) => mapHttpClientError(error, origin)),
      );
      const httpError = statusError(response.status, origin);
      if (httpError !== undefined) return yield* Effect.fail(httpError);
      return tapProgress(
        response.stream.pipe(
          Stream.mapError((error: HttpClientError.HttpClientError) => mapHttpClientError(error, origin)),
        ),
      );
    });

    const offlineMiss = () =>
      Effect.fail(
        new DownloadOfflineError({
          message: "Offline mode is enabled and the artifact is not present in the verified cache.",
          urlOrigin: origin,
        }),
      );

    const core = Effect.gen(function* () {
      const sourceError = validateSource(request);
      if (sourceError !== undefined) return yield* Effect.fail(sourceError);

      if (request.destination.kind === "file") {
        const { directory, filename } = request.destination;
        const destinationError = validateDestinationFilename(filename);
        if (destinationError !== undefined) return yield* Effect.fail(destinationError);
        const destinationPath = join(directory, filename);
        const cached = yield* tryCacheHit(request, destinationPath);
        if (cached !== undefined) return cached;
        if (request.offline === true) return yield* offlineMiss();

        const body = yield* fetchBody();
        const result = yield* persistVerifiedStream({
          body,
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

      if (request.offline === true) return yield* offlineMiss();
      const body = yield* fetchBody();
      const result = yield* collectVerifiedStream({
        body,
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
    }).pipe(Effect.catchTag("VerifiedStreamError", (error) => Effect.fail(mapVerifiedError(error, origin))));

    const publishPost = Effect.fnUntraced(function* (exit: Exit.Exit<DownloadResult, DownloadError>) {
      const bodyBytes = yield* Ref.get(progress);
      const endedAt = yield* Clock.currentTimeMillis;
      const durationMs = endedAt - startedAt;
      const timestamp = yield* DateTime.now;
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
            timestamp,
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
          bytesDownloaded: bodyBytes > 0 ? bodyBytes : undefined,
          sha256: undefined,
          durationMs,
          failureDetail: failureDetailFromExitCause(exit.cause),
          redact,
          timestamp,
        }),
      );
    });

    return yield* core.pipe(Effect.onExit(publishPost));
  }),
});
