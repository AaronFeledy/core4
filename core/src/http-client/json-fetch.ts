/**
 * Plain-async bridge from Lando-owned metadata fetches to {@link HttpClient}.
 *
 * Recipe/npm/registry metadata clients are Promise-based and live below the
 * Effect layer, but their outbound HTTP must still flow through the one
 * canonical `HttpClient` egress boundary (proxy/CA/redaction/events) rather than
 * calling `fetch` directly. This helper resolves `HttpClientLive`, issues a
 * single `stream` request, and collects the body into bytes — exposing a tiny
 * `{ status, bytes }` result that callers turn into JSON with their existing
 * status semantics (404 -> undefined, non-2xx -> throw).
 */

import { Duration, Effect, Layer, Stream } from "effect";

import { ConfigServiceLive } from "../services/config.ts";
import { EventServiceLive } from "../services/event-service.ts";
import { HttpClientLive } from "./live.ts";
import { HttpClient } from "./service.ts";

export interface HttpJsonResult {
  readonly status: number;
  readonly bytes: Uint8Array;
}

export interface HttpJsonOptions {
  /** Extra request headers (e.g. `accept: application/json`). */
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Redirect mode; defaults to following redirects like the prior fetch calls. */
  readonly redirect?: "follow" | "error" | "manual";
  /** Optional overall timeout; mirrors call sites that used `AbortSignal.timeout`. */
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

/**
 * Fetch a URL through `HttpClientLive` and return its status plus body bytes.
 *
 * Throws when the request fails to connect (the rejected Effect cause). Non-2xx
 * responses still resolve so callers keep their own status handling.
 */
export const httpJsonFetch = async (url: string, options: HttpJsonOptions = {}): Promise<HttpJsonResult> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpClient;
        const response = yield* client.stream({
          url,
          redirect: options.redirect ?? "follow",
          ...(options.headers === undefined ? {} : { headers: options.headers }),
        });
        const chunks = yield* Stream.runCollect(response.body);
        return { status: response.status, bytes: collectBytes(Array.from(chunks)) };
      }).pipe(
        (effect) =>
          options.timeoutMs === undefined
            ? effect
            : effect.pipe(Effect.timeout(Duration.millis(options.timeoutMs))),
        Effect.provide(
          Layer.mergeAll(HttpClientLive.pipe(Layer.provide(EventServiceLive)), ConfigServiceLive),
        ),
      ),
    ),
  );
