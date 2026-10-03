/**
 * Plain-async bridge from Lando-owned metadata fetches to Effect's HttpClient.
 *
 * Recipe/npm/registry metadata clients are Promise-based and live below the
 * Effect layer, but their outbound HTTP must still flow through the one
 * canonical `@lando/http-client` egress boundary (proxy/CA/redaction/events)
 * rather than calling `fetch` directly. This helper resolves the Lando layer,
 * issues a single `get`, and collects the body into bytes — exposing a tiny
 * `{ status, bytes }` result that callers turn into JSON with their existing
 * status semantics (404 -> undefined, non-2xx -> throw).
 */

import { Duration, Effect, Layer, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { RequestPolicy, layer as httpClientLayer } from "@lando/http-client/live";
import { ConfigServiceLive } from "./config.ts";
import { EventServiceLive } from "./event-service.ts";

export interface HttpJsonResult {
  readonly status: number;
  readonly bytes: Uint8Array;
}

export interface HttpJsonOptions {
  /** Extra request headers (e.g. `accept: application/json`). */
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Redirect mode; defaults to following redirects like the prior fetch calls. */
  readonly redirect?: "follow" | "error" | "manual";
  /** Optional overall deadline applied with `Effect.timeout` around get + body. */
  readonly timeoutMs?: number;
}

const collectBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const headersRecord = (headers: HttpJsonOptions["headers"]): Record<string, string> | undefined => {
  if (headers === undefined || headers.length === 0) return undefined;
  return Object.fromEntries(headers.map(({ name, value }) => [name, value]));
};

/**
 * Fetch a URL through the Lando HttpClient layer and return its status plus body bytes.
 *
 * Throws when the request fails to connect (the rejected Effect cause). Non-2xx
 * responses still resolve so callers keep their own status handling.
 */
export const httpJsonFetch = async (url: string, options: HttpJsonOptions = {}): Promise<HttpJsonResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const headers = headersRecord(options.headers);
      const get = client.get(url, headers === undefined ? undefined : { headers }).pipe(
        Effect.provideService(RequestPolicy, {
          redirect: options.redirect ?? "follow",
        }),
      );
      const response = yield* get;
      const chunks = yield* Stream.runCollect(response.stream);
      return { status: response.status, bytes: collectBytes(Array.from(chunks)) };
    }).pipe(
      options.timeoutMs === undefined
        ? (effect) => effect
        : Effect.timeout(Duration.millis(options.timeoutMs)),
      Effect.provide(
        Layer.mergeAll(httpClientLayer.pipe(Layer.provide(EventServiceLive)), ConfigServiceLive),
      ),
    ),
  );
