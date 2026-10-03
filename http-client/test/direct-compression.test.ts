import { afterEach, expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { Duration, Effect, Result, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { layer, layerWith } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";

const decoded = new TextEncoder().encode("decoded-body");
const encodings = [
  { encoding: "gzip", bytes: gzipSync(decoded) },
  { encoding: "deflate", bytes: deflateSync(decoded) },
  { encoding: "br", bytes: brotliCompressSync(decoded) },
  { encoding: "identity", bytes: decoded },
  { encoding: "unknown", bytes: decoded },
] as const;

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
afterEach(() => {
  for (const key of proxyKeys) Reflect.deleteProperty(process.env, key);
});

const clearAmbientProxy = () => {
  for (const key of proxyKeys) Reflect.deleteProperty(process.env, key);
};

for (const explicitNoProxy of [false, true]) {
  test.each([...encodings])(
    `decodes $encoding like Bun fetch with explicitNoProxy=${explicitNoProxy}`,
    async ({ encoding, bytes }) => {
      clearAmbientProxy();
      // Given compressed wire bytes and unchanged content headers at a local endpoint.
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(bytes, {
            headers: {
              "content-encoding": encoding,
              "content-length": String(bytes.length),
              "x-retained": "yes",
            },
          }),
      });
      const url = explicitNoProxy ? `http://[::ffff:127.0.0.1]:${server.port}/` : server.url.href;
      try {
        const baseline = await fetch(server.url, {
          signal: AbortSignal.timeout(1000),
          proxy: undefined,
        } as RequestInit);
        const expected = new Uint8Array(await baseline.arrayBuffer());
        // When the production client selects loopback or explicit NO_PROXY direct transport.
        const actual = await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const response = yield* client.get(url).pipe(Effect.timeout(Duration.millis(1000)));
            const chunks = yield* Stream.runCollect(response.stream);
            return { bytes: Array.from(chunks).flatMap((chunk) => [...chunk]), headers: response.headers };
          }).pipe(
            Effect.provide(layerWith()),
            Effect.provideService(NetworkTrust, {
              proxy: { http: "http://unreachable.invalid:3128", noProxy: explicitNoProxy ? ["*"] : [] },
              caPems: [],
              trustHost: true,
            }),
          ),
        );
        // Then decoded bytes match fetch while original wire headers remain visible.
        expect(actual.bytes).toEqual([...expected]);
        expect(actual.bytes).toEqual([...decoded]);
        for (const name of ["content-encoding", "content-length", "x-retained"] as const) {
          expect(actual.headers[name]).toBe(baseline.headers.get(name) ?? undefined);
        }
      } finally {
        server.stop(true);
      }
    },
  );
}

for (const bytes of [new Uint8Array(), new Uint8Array([255, 255, 255, 255])]) {
  test.each(["gzip", "deflate", "br"])(
    `bounds invalid/empty %s body with ${bytes.length} wire bytes`,
    async (encoding) => {
      clearAmbientProxy();
      // Given an empty or malformed encoded response with a finite wire body.
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(bytes, {
            headers: { "content-encoding": encoding },
          }),
      });
      try {
        const baseline = await fetch(server.url, {
          signal: AbortSignal.timeout(1000),
          proxy: undefined,
        } as RequestInit)
          .then((response) => response.arrayBuffer())
          .then(
            (body) => ({ ok: true, bytes: [...new Uint8Array(body)] }),
            () => ({ ok: false, bytes: [] }),
          );
        // When the production stream attempts decoding within its timeout budget.
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const response = yield* client.get(server.url.href).pipe(Effect.timeout(Duration.millis(1000)));
            return yield* Stream.runCollect(response.stream);
          }).pipe(Effect.provide(layer), Effect.result),
        );
        // Then completion/failure matches fetch when possible; empty wire + encoding may
        // succeed on the direct transport (parent closes empty encoded body) even when
        // Bun fetch rejects — assert no timeout either way.
        if (Result.isSuccess(result)) {
          if (baseline.ok) {
            expect(Array.from(result.success).flatMap((chunk) => [...chunk])).toEqual(baseline.bytes);
          } else {
            // Direct transport accepted empty encoded body; not a timeout.
            expect(Array.from(result.success).flatMap((chunk) => [...chunk])).toEqual([]);
          }
        } else {
          expect((result.failure as { _tag?: string })._tag).not.toBe("TimeoutError");
          expect(baseline.ok).toBe(false);
        }
      } finally {
        server.stop(true);
      }
    },
  );
}
