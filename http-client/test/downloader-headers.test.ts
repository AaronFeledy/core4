import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Downloader, EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect, Layer, Queue, Stream } from "effect";
import { layer as downloaderLayer } from "../src/downloader";
import { layerWith } from "../src/live";

test("forwards download headers, strips Authorization cross-origin, and ignores headers on verified cache hits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-download-headers-"));
  const token = "literal-registry-token-not-in-env";
  const payload = new TextEncoder().encode("private package bytes");
  const sha256 = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  const calls: { url: string; authorization: string | null; safe: string | null }[] = [];
  const events: LandoEvent[] = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization"), safe: headers.get("x-safe") });
      return url.startsWith("https://registry.test/")
        ? new Response(null, { status: 302, headers: { location: "https://cdn.test/archive" } })
        : new Response(payload);
    },
    { preconnect: fetch.preconnect },
  );
  const capture = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<LandoEvent>(),
      subscribeWithHistory: () => Effect.never,
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  );
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const downloader = yield* Downloader;
          const request = {
            url: "https://registry.test/package.tgz",
            destination: { kind: "file" as const, directory, filename: "package.tgz" },
            expectedSha256: sha256,
            redactionTokens: [token],
          };
          const first = yield* downloader.download({
            ...request,
            headers: [
              { name: "Authorization", value: `Bearer ${token}` },
              { name: "x-safe", value: "keep" },
            ],
          });
          const second = yield* downloader.download({
            ...request,
            headers: [{ name: "Authorization", value: "Bearer changed" }],
          });
          return { first, second };
        }),
      ).pipe(
        Effect.provide(
          downloaderLayer.pipe(Layer.provide(Layer.merge(layerWith({ fetch: fetchImpl }), capture))),
        ),
      ),
    );
    expect(result.first.fromCache).toBe(false);
    expect(result.second.fromCache).toBe(true);
    expect(calls).toEqual([
      { url: "https://registry.test/package.tgz", authorization: `Bearer ${token}`, safe: "keep" },
      { url: "https://cdn.test/archive", authorization: null, safe: "keep" },
    ]);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["literal-header-error-token-1489", "1234"])(
  "redacts Authorization token %s from transport errors and lifecycle events",
  async (token) => {
    const events: LandoEvent[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        throw new Error(`network ${token}`);
      },
      { preconnect: fetch.preconnect },
    );
    const capture = Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<LandoEvent>(),
        subscribeWithHistory: () => Effect.never,
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    );
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(Downloader, (downloader) =>
          downloader.download({
            url: "https://registry.test/package.tgz",
            destination: { kind: "memory" },
            headers: [{ name: "authorization", value: `Bearer ${token}` }],
            redactionTokens: [token],
          }),
        ),
      ).pipe(
        Effect.provide(
          downloaderLayer.pipe(Layer.provide(Layer.merge(layerWith({ fetch: fetchImpl }), capture))),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(token);
  },
);
