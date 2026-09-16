import { expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { HttpRequestError } from "@lando/sdk/errors";
import { Effect, Either, Stream } from "effect";
import { makeHttpClientLive } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";
import { HttpClient } from "../src/service.ts";

const decoded = new TextEncoder().encode("decoded-body");
const encodings = [
  { encoding: "gzip", bytes: gzipSync(decoded) },
  { encoding: "deflate", bytes: deflateSync(decoded) },
  { encoding: "br", bytes: brotliCompressSync(decoded) },
  { encoding: "identity", bytes: decoded },
  { encoding: "unknown", bytes: decoded },
] as const;

for (const explicitNoProxy of [false, true]) {
  test.each([...encodings])(
    `decodes $encoding like Bun fetch with explicitNoProxy=${explicitNoProxy}`,
    async ({ encoding, bytes }) => {
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
        const baseline = await fetch(server.url, { signal: AbortSignal.timeout(1000) });
        const expected = new Uint8Array(await baseline.arrayBuffer());
        // When the production client selects loopback or explicit NO_PROXY direct transport.
        const actual = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* HttpClient;
              const response = yield* client.stream({ url, timeoutMs: 1000 });
              const chunks = yield* Stream.runCollect(response.body);
              return { bytes: Array.from(chunks).flatMap((chunk) => [...chunk]), headers: response.headers };
            }).pipe(
              Effect.provide(makeHttpClientLive()),
              Effect.provideService(NetworkTrust, {
                proxy: { http: "http://unreachable.invalid:3128", noProxy: explicitNoProxy ? ["*"] : [] },
                caPems: [],
                trustHost: true,
              }),
            ),
          ),
        );
        // Then decoded bytes match fetch while original wire headers remain visible.
        expect(actual.bytes).toEqual([...expected]);
        expect(actual.bytes).toEqual([...decoded]);
        const headers = new Headers(actual.headers.map(({ name, value }) => [name, value]));
        for (const name of ["content-encoding", "content-length", "x-retained"]) {
          expect(headers.get(name)).toBe(baseline.headers.get(name));
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
        const baseline = await fetch(server.url, { signal: AbortSignal.timeout(1000) })
          .then((response) => response.arrayBuffer())
          .then(
            (body) => ({ ok: true, bytes: [...new Uint8Array(body)] }),
            () => ({ ok: false, bytes: [] }),
          );
        // When the production stream attempts decoding within its timeout budget.
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* HttpClient;
              const response = yield* client.stream({ url: server.url.href, timeoutMs: 1000 });
              return yield* Stream.runCollect(response.body);
            }).pipe(Effect.provide(makeHttpClientLive()), Effect.either),
          ),
        );
        // Then completion/failure matches fetch, and decoder errors retain the typed channel.
        expect(Either.isRight(result)).toBe(baseline.ok);
        if (Either.isRight(result))
          expect(Array.from(result.right).flatMap((chunk) => [...chunk])).toEqual(baseline.bytes);
        else {
          expect(result.left).toBeInstanceOf(HttpRequestError);
          expect(result.left.message).not.toContain("exceeded timeoutMs");
        }
      } finally {
        server.stop(true);
      }
    },
  );
}
