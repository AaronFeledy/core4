/** In-memory `Downloader` double: production `makeDownloaderService` over a stub Effect `HttpClient`. */
import { Effect, Queue } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { createSecretRedactor } from "@lando/sdk/secrets";
import type { DownloaderShape, LandoEvent } from "@lando/sdk/services";

import { type DownloaderEvents, makeDownloaderService } from "@lando/http-client/downloader";

export interface TestDownloaderHandle {
  readonly service: DownloaderShape;
  /** Register the bytes a `https://`/`file://` source URL resolves to. */
  readonly serve: (url: string, bytes: Uint8Array) => void;
  readonly failResets: (url: string, count: number) => void;
  readonly serveStatus: (url: string, status: number) => void;
  readonly nextRetry: Effect.Effect<void>;
  /** Snapshot the lifecycle events the downloader published. */
  readonly events: () => ReadonlyArray<LandoEvent>;
  /** Number of egress GET calls issued through the in-memory `HttpClient`. */
  readonly streamCallCount: () => number;
  /** Total bytes streamed through the in-memory `HttpClient`. */
  readonly bytesStreamed: () => number;
}

export const makeTestDownloader = Effect.fnUntraced(function* (): Effect.fn.Return<TestDownloaderHandle> {
  const retries = yield* Queue.unbounded<void>();
  const resets = new Map<string, number>();
  const statuses = new Map<string, number>();
  const sources = new Map<string, Uint8Array>();
  const captured: Array<LandoEvent> = [];
  let streamCalls = 0;
  let bytesStreamed = 0;

  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      streamCalls += 1;
      const remaining = resets.get(request.url) ?? 0;
      if (remaining > 0) {
        resets.set(request.url, remaining - 1);
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new TypeError("Connection reset"), { code: "ECONNRESET" }),
            }),
          }),
        );
      }
      const status = statuses.get(request.url);
      if (status !== undefined)
        return HttpClientResponse.fromWeb(request, new Response("failure", { status }));
      const body = sources.get(url.href) ?? sources.get(request.url);
      if (body === undefined) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: "no source registered",
              description: "no source registered",
            }),
          }),
        );
      }
      bytesStreamed += body.length;
      return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
    }),
  );

  const { redact } = createSecretRedactor([]);
  const events: DownloaderEvents = {
    redactText: redact,
    publish: (event) =>
      Effect.sync(() => void captured.push(event)).pipe(
        Effect.andThen(event._tag === "message.warn" ? Queue.offer(retries, undefined) : Effect.void),
        Effect.asVoid,
      ),
  };

  return {
    service: makeDownloaderService(http, events),
    serve: (url, body) => void sources.set(url, body),
    failResets: (url, count) => void resets.set(url, count),
    serveStatus: (url, status) => void statuses.set(url, status),
    nextRetry: Queue.take(retries),
    events: () => [...captured],
    streamCallCount: () => streamCalls,
    bytesStreamed: () => bytesStreamed,
  };
});
