/**
 * `TestDownloader` — an in-memory `Downloader` double for plugin authors and
 * embedding hosts.
 *
 * It reuses the real `makeDownloaderService` over an in-memory `HttpClient`
 * (mirroring how `TestManagedFileStore` reuses the real service over an
 * in-memory backend), so scheme gating, checksum/size verification, cache,
 * offline, and event publication exercise the production code path. It never
 * opens a socket; the source map is the only stand-in for the network. File
 * destinations write to the real filesystem so cache-hit hashing is faithful.
 */
import { Effect, Stream } from "effect";

import { createSecretRedactor } from "@lando/sdk/secrets";
import type { DownloaderShape } from "@lando/sdk/services";
import type { LandoEvent } from "@lando/sdk/services";

import { type DownloaderEvents, makeDownloaderService } from "../downloader/service.ts";
import { type HttpClientShape, HttpStreamError } from "../http-client/service.ts";

export interface TestDownloaderHandle {
  readonly service: DownloaderShape;
  /** Register the bytes a `https://`/`file://` source URL resolves to. */
  readonly serve: (url: string, bytes: Uint8Array) => void;
  /** Snapshot the lifecycle events the downloader published. */
  readonly events: () => ReadonlyArray<LandoEvent>;
  /** Number of egress stream calls issued through the in-memory `HttpClient`. */
  readonly streamCallCount: () => number;
  /** Total bytes streamed through the in-memory `HttpClient`. */
  readonly bytesStreamed: () => number;
}

export const makeTestDownloader = (): Effect.Effect<TestDownloaderHandle> =>
  Effect.sync(() => {
    const sources = new Map<string, Uint8Array>();
    const captured: Array<LandoEvent> = [];
    let streamCalls = 0;
    let bytesStreamed = 0;

    const http: HttpClientShape = {
      id: "test-downloader-http",
      stream: (request) =>
        Effect.suspend(() => {
          streamCalls += 1;
          const body = sources.get(request.url);
          if (body === undefined) {
            return Effect.fail(
              new HttpStreamError({ message: "no source registered", url: request.url, status: 404 }),
            );
          }
          bytesStreamed += body.length;
          return Effect.succeed({
            status: 200,
            headers: new Map<string, string>(),
            body: Stream.fromIterable([body]),
          });
        }),
    };

    const { redact } = createSecretRedactor([]);
    const events: DownloaderEvents = {
      redactText: redact,
      publish: (event) => Effect.sync(() => void captured.push(event)),
    };

    return {
      service: makeDownloaderService(http, events),
      serve: (url, bytes) => void sources.set(url, bytes),
      events: () => [...captured],
      streamCallCount: () => streamCalls,
      bytesStreamed: () => bytesStreamed,
    };
  });
