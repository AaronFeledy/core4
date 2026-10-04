/** In-memory `Downloader` double: production `makeDownloaderService` over a stub Effect `HttpClient`. */
import { Effect } from "effect";
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
  /** Snapshot the lifecycle events the downloader published. */
  readonly events: () => ReadonlyArray<LandoEvent>;
  /** Number of egress GET calls issued through the in-memory `HttpClient`. */
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

    const http = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        streamCalls += 1;
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
      publish: (event) => Effect.sync(() => void captured.push(event)),
    };

    return {
      service: makeDownloaderService(http, events),
      serve: (url, body) => void sources.set(url, body),
      events: () => [...captured],
      streamCallCount: () => streamCalls,
      bytesStreamed: () => bytesStreamed,
    };
  });
