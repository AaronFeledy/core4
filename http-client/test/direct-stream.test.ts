import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { Effect, Stream } from "effect";
import { makeHttpClientLive } from "../src/live.ts";
import { HttpClient } from "../src/service.ts";

test.each([
  { encoding: "gzip", bytes: gzipSync("decoded-body") },
  { encoding: "deflate", bytes: deflateSync("decoded-body") },
  { encoding: "br", bytes: brotliCompressSync("decoded-body") },
])(
  "streams $encoding before EOF and destroys the compressed socket on scope close",
  async ({ encoding, bytes }) => {
    // Given a compressed chunk on a connection that deliberately never reaches EOF.
    const closed = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.on("close", () => closed.resolve());
      response.writeHead(200, { "content-encoding": encoding });
      response.write(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP listener");
    try {
      // When the scoped consumer takes one decoded chunk rather than buffering the body.
      const chunks = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* HttpClient;
            const response = yield* client.stream({
              url: `http://127.0.0.1:${address.port}/`,
              timeoutMs: 1000,
            });
            return yield* Stream.runCollect(response.body.pipe(Stream.take(1)));
          }).pipe(Effect.provide(makeHttpClientLive())),
        ),
      );
      await closed.promise;
      // Then decompression emits before EOF and cancellation closes the source socket.
      expect(
        new TextDecoder().decode(new Uint8Array(Array.from(chunks).flatMap((chunk) => [...chunk]))),
      ).toBe("decoded-body");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
);

test.each([false, true])(
  "destroys the direct socket on scope close with body consumed=%s",
  async (consume) => {
    // Given a real endpoint that sends headers and one chunk, but never completes.
    const closed = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.on("close", () => closed.resolve());
      response.writeHead(200, { "x-status": "ready" });
      response.write("first chunk");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP listener");
    try {
      // When a scoped caller takes only headers or a single chunk.
      const status = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* HttpClient;
            const response = yield* client.stream({
              url: `http://127.0.0.1:${address.port}/`,
              timeoutMs: 1000,
            });
            if (consume) yield* Stream.runDrain(response.body.pipe(Stream.take(1)));
            return response.status;
          }).pipe(Effect.provide(makeHttpClientLive())),
        ),
      );
      await closed.promise;
      // Then scope completion does not wait for EOF and destroys the live socket.
      expect(status).toBe(200);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
);

test("carries method and headers and streams the response bytes", async () => {
  // Given a direct endpoint that echoes request metadata and body bytes.
  const seen: { method: string; token: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({ method: request.method, token: request.headers.get("x-token") });
      return new Response(new Uint8Array([0, 1, 254, 255]));
    },
  });
  try {
    // When an explicit method/header request is streamed to completion.
    const chunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient;
          const response = yield* client.stream({
            url: server.url.href,
            method: "PUT",
            headers: [{ name: "x-token", value: "test" }],
          });
          return yield* Stream.runCollect(response.body);
        }).pipe(Effect.provide(makeHttpClientLive())),
      ),
    );
    // Then the adapter preserves metadata and binary bytes without text conversion.
    expect(seen).toEqual([{ method: "PUT", token: "test" }]);
    expect(Array.from(chunks).flatMap((chunk) => [...chunk])).toEqual([0, 1, 254, 255]);
  } finally {
    server.stop(true);
  }
});
