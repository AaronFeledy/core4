/**
 * Core download body: cache, offline, stream, verify, and lifecycle events.
 */
import { join } from "node:path";
import { mapFailures, mapStreamFailures } from "@lando/sdk/command-result";

import { Clock, DateTime, Effect, type Exit, Ref, Stream } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";

import { createStandaloneRedactor } from "@lando/redaction/service";
import { DownloadOfflineError } from "@lando/sdk/errors";
import type { DownloadRequest, DownloadResult, DownloaderCapabilities } from "@lando/sdk/schema";
import type { DownloaderShape } from "@lando/sdk/services";
import { OnlineAcquisition } from "@lando/sdk/services";
import { CurrentTaskDetail } from "@lando/sdk/task-progress";
import { collectVerifiedStream, persistVerifiedStream } from "@lando/sdk/verified-stream";

import { tryCacheHit } from "./downloader-cache.ts";
import {
  type DownloadError,
  mapHttpClientError,
  mapVerifiedError,
  statusError,
} from "./downloader-errors.ts";
import { makeDownloadEventBuilders } from "./downloader-event-builders.ts";
import {
  type DownloaderEvents,
  failureDetailFromExitCause,
  noopDownloaderEvents,
} from "./downloader-events.ts";
import { fetchFailure } from "./downloader-failure.ts";
import { runWithTransientRetry } from "./downloader-retry.ts";
import { urlOrigin, validateDestinationFilename, validateSource } from "./downloader-validate.ts";
import { RequestPolicy, type RequestPolicyShape } from "./policy.ts";

const CAPABILITIES: DownloaderCapabilities = {
  schemes: ["https", "file"],
  memoryDownload: true,
  cacheAware: true,
  offline: true,
  mirror: false,
};

const HEADER_TIMEOUT = "120 seconds";
const IDLE_TIMEOUT = "60 seconds";

/** Build the fiber-local egress policy for one download request. */
const requestPolicyFor = (request: DownloadRequest): RequestPolicyShape => ({
  onBehalfOf: "downloader",
  ...(request.callerId === undefined ? {} : { callerId: request.callerId }),
  ...(request.redactionTokens === undefined ? {} : { redactionTokens: request.redactionTokens }),
  ...(request.allowFileSource === undefined ? {} : { allowFileSource: request.allowFileSource }),
  ...(request.offline === undefined ? {} : { offline: request.offline }),
});

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
    const tokenRedactor = createStandaloneRedactor("secrets", {
      authoritativeTokens: request.redactionTokens,
    });
    const tokenRedact = tokenRedactor.redactString;
    const redact = (text: string): string => tokenRedact(events.redactText(text));
    const callerId = request.callerId;
    const policy = requestPolicyFor(request);

    const filename = request.destination.kind === "file" ? request.destination.filename : undefined;
    const source = {
      origin: redact(origin),
      filename: filename === undefined ? undefined : redact(filename),
    };
    const network = !request.url.startsWith("file:");
    const enabled = (yield* OnlineAcquisition) && network;
    const build = makeDownloadEventBuilders({
      origin,
      callerId,
      expectedSizeBytes: request.expectedSizeBytes,
      filename,
      redact,
    });

    const startedAt = yield* Clock.currentTimeMillis;
    const progress = yield* Ref.make(0);
    const attempts = yield* Ref.make(0);

    const tapProgress = <E, R>(body: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
      body.pipe(
        Stream.tap((chunk) =>
          Ref.updateAndGet(progress, (total) => total + chunk.length).pipe(
            Effect.flatMap((total) =>
              DateTime.now.pipe(
                Effect.flatMap((timestamp) => events.publish(build.progress(total, timestamp))),
              ),
            ),
          ),
        ),
      );

    const fetchBody = Effect.fnUntraced(function* () {
      const headers = http
        .get(
          request.url,
          request.headers === undefined
            ? undefined
            : {
                headers: Object.fromEntries(request.headers.map(({ name, value }) => [name, value])),
              },
        )
        .pipe(
          Effect.provideService(RequestPolicy, policy),
          mapFailures((error: HttpClientError.HttpClientError) =>
            mapHttpClientError(error, source, tokenRedactor),
          ),
        );
      const response = yield* network
        ? headers.pipe(
            Effect.timeoutOrElse({
              duration: HEADER_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  fetchFailure(source, {
                    reason: "timeout",
                    detail: "the server sent no response for 120 seconds",
                  }),
                ),
            }),
          )
        : headers;
      const httpError = statusError(response.status, source);
      if (httpError !== undefined) return yield* Effect.fail(httpError);
      const body = response.stream.pipe(
        mapStreamFailures((error: HttpClientError.HttpClientError) =>
          mapHttpClientError(error, source, tokenRedactor),
        ),
      );
      return tapProgress(
        network
          ? body.pipe(
              Stream.timeoutOrElse({
                duration: IDLE_TIMEOUT,
                orElse: () =>
                  Stream.fail(
                    fetchFailure(source, { reason: "timeout", detail: "no data arrived for 60 seconds" }),
                  ),
              }),
            )
          : body,
      );
    });

    const offlineMiss = () =>
      Effect.fail(
        new DownloadOfflineError({
          message: "Offline mode is enabled and the artifact is not present in the verified cache.",
          urlOrigin: origin,
          remediation:
            "Disable offline mode or seed the verified cache for this origin, then retry; connecting alone leaves offline mode enabled.",
        }),
      );

    const retryWarning = Effect.fnUntraced(function* (
      reason: string,
      nextAttempt: number,
      maxAttempts: number,
    ) {
      const sink = yield* CurrentTaskDetail;
      const timestamp = yield* DateTime.now;
      const warning = build.retryWarning({ reason, nextAttempt, maxAttempts, timestamp });
      yield* sink === undefined ? events.publish(warning) : sink(warning.body);
    });

    // One complete attempt: a fresh GET, verification, and atomic write, with
    // its response, temp file, and handle released when the attempt ends.
    const transfer = (destinationPath: string | undefined) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Ref.set(progress, 0);
          const body = yield* fetchBody();
          if (destinationPath === undefined) {
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
          }
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
        }),
      ).pipe(Effect.catchTag("VerifiedStreamError", (error) => Effect.fail(mapVerifiedError(error, origin))));

    const fetchWithRetry = (destinationPath: string | undefined) =>
      runWithTransientRetry({
        enabled,
        attempts,
        attempt: transfer(destinationPath),
        onRetry: retryWarning,
      });

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
        return yield* fetchWithRetry(destinationPath);
      }

      if (request.offline === true) return yield* offlineMiss();
      return yield* fetchWithRetry(undefined);
    });

    const publishPost = Effect.fnUntraced(function* (exit: Exit.Exit<DownloadResult, DownloadError>) {
      const bodyBytes = yield* Ref.get(progress);
      const attemptCount = yield* Ref.get(attempts);
      const endedAt = yield* Clock.currentTimeMillis;
      const durationMs = endedAt - startedAt;
      const timestamp = yield* DateTime.now;
      if (exit._tag === "Success") {
        const value = exit.value;
        yield* events.publish(
          build.post({
            outcome: "success",
            fromCache: value.fromCache,
            bytesDownloaded: value.fromCache ? 0 : value.sizeBytes,
            sha256: value.sha256,
            durationMs,
            failureDetail: undefined,
            attempts: attemptCount,
            timestamp,
          }),
        );
        return;
      }
      yield* events.publish(
        build.post({
          outcome: "failure",
          fromCache: false,
          bytesDownloaded: bodyBytes > 0 ? bodyBytes : undefined,
          sha256: undefined,
          durationMs,
          failureDetail: failureDetailFromExitCause(exit.cause),
          attempts: attemptCount,
          timestamp,
        }),
      );
    });

    // Pre-download publishes uninterruptibly, so once it is out the paired
    // post-download always follows, including on interruption.
    const preTimestamp = yield* DateTime.now;
    return yield* Effect.uninterruptibleMask((restore) =>
      events
        .publish(build.pre(preTimestamp))
        .pipe(Effect.andThen(restore(core).pipe(Effect.onExit(publishPost)))),
    );
  }),
});
