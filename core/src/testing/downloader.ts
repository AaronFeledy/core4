/** In-memory `Downloader` double: production `makeDownloaderService` over a stub `HttpClient`. */
import { Effect, Stream } from "effect";

import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import type { HttpClientCapabilities } from "@lando/sdk/schema";
import { createSecretRedactor } from "@lando/sdk/secrets";
import type { DownloaderShape } from "@lando/sdk/services";
import type { LandoEvent } from "@lando/sdk/services";

import { type DownloaderEvents, makeDownloaderService } from "../downloader/service.ts";
import type { HttpClientShape } from "../http-client/service.ts";

const TEST_HTTP_CAPABILITIES: HttpClientCapabilities = {
  schemes: ["https", "http", "file"],
  streaming: true,
  upload: false,
  customCa: true,
  proxyAware: true,
};

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
      capabilities: TEST_HTTP_CAPABILITIES,
      request: (request) =>
        Effect.suspend(() => {
          const body = sources.get(request.url);
          if (body === undefined) {
            return Effect.fail(
              new HttpRequestError({ message: "no source registered", urlOrigin: request.url, status: 404 }),
            );
          }
          return Effect.succeed({ status: 200, headers: [], contentLength: body.length });
        }),
      stream: (request) =>
        Effect.suspend(() => {
          streamCalls += 1;
          const body = sources.get(request.url);
          if (body === undefined) {
            return Effect.fail(
              new HttpRequestError({ message: "no source registered", urlOrigin: request.url, status: 404 }),
            );
          }
          bytesStreamed += body.length;
          return Effect.succeed({
            status: 200,
            headers: [],
            body: Stream.fromIterable([body]),
          });
        }),
      upload: (request) =>
        Effect.fail(new HttpUploadError({ message: "upload not supported", urlOrigin: request.url })),
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
