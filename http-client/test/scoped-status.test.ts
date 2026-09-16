import { expect, test } from "bun:test";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { makeHttpClientLive } from "../src/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../src/network-trust.ts";
import { HttpClient } from "../src/service.ts";

const trust: ResolvedNetworkTrust = {
  proxy: {
    http: "http://proxy.test:3128",
    https: "http://secure-proxy.test:3128",
    noProxy: ["excluded.test"],
  },
  caPems: ["custom-ca"],
  trustHost: true,
};

test.each([
  ["http://localhost:8080", "direct"],
  ["http://LOCALHOST:8080", "direct"],
  ["http://127.0.0.1:8080", "direct"],
  ["http://127.254.1.2:8080", "direct"],
  ["https://[::1]:8443", "direct"],
  ["https://[0:0:0:0:0:0:0:1]:8443", "direct"],
  ["https://excluded.test", "direct"],
  ["https://remote.test", "http://secure-proxy.test:3128"],
  ["http://app.lndo.site", "http://proxy.test:3128"],
  ["http://0.0.0.0:8080", "http://proxy.test:3128"],
  ["http://localhost.attacker.test", "http://proxy.test:3128"],
  ["http://128.0.0.1", "http://proxy.test:3128"],
])("uses endpoint proxy policy for %s without changing CA trust", async (url, proxy) => {
  // Given resolved proxy and custom CA trust at the egress boundary.
  let captured: BunFetchRequestInit | undefined;
  let direct = false;
  const fetchImpl: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      captured = init;
      return new Response(null, { status: 204 });
    },
    { preconnect: fetch.preconnect },
  );
  // When a status-only stream is opened and scoped out.
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(HttpClient, (client) => client.stream({ url })).pipe(
        Effect.provide(
          makeHttpClientLive(
            fetchImpl,
            () => ["host-ca"],
            async (_url, init) => {
              direct = true;
              captured = { tls: { ca: [...(init.ca ?? [])] } };
              return new Response(null, { status: 204 });
            },
          ),
        ),
        Effect.provideService(NetworkTrust, trust),
      ),
    ),
  );
  // Then proxy policy changes routing only, not certificate verification.
  expect(direct ? "direct" : captured?.proxy).toBe(proxy);
  expect(captured?.tls).toEqual({ ca: ["host-ca", "custom-ca"] });
});

test.each([false, true])("pairs events once and releases a stream when consumed=%s", async (consume) => {
  // Given an observable response reader and request signal.
  const events: LandoEvent[] = [];
  let canceled = 0;
  let signal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            canceled += 1;
          },
        }),
        { status: 503 },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const eventLayer = Layer.succeed(EventService, {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.never,
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });
  // When the caller reads only headers or one chunk before closing its scope.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpClient;
        const response = yield* client.stream({ url: "http://localhost/status" });
        if (consume) yield* Stream.runDrain(response.body.pipe(Stream.take(1)));
      }).pipe(
        Effect.provide(makeHttpClientLive(fetchImpl, () => [], fetchImpl).pipe(Layer.provide(eventLayer))),
      ),
    ),
  );
  // Then even a non-2xx status is a successful transport with exactly one pair.
  expect(canceled).toBe(1);
  expect(signal?.aborted).toBe(true);
  expect(events.map((event) => event._tag)).toEqual(["pre-http-call", "post-http-call"]);
  expect(events.find((event) => event._tag === "post-http-call")).toMatchObject({
    outcome: "success",
    status: 503,
  });
});

test("aborts and pairs events when a header-only scope is interrupted", async () => {
  // Given a stream whose headers are available and body is never consumed.
  const events: LandoEvent[] = [];
  let canceled = false;
  let signal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    },
    { preconnect: fetch.preconnect },
  );
  const eventLayer = Layer.succeed(EventService, {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.never,
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });
  // When interrupted after opening the response, without timing-based polling.
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient;
          yield* client.stream({ url: "http://localhost/status" });
          yield* Deferred.succeed(ready, undefined);
          yield* Effect.never;
        }).pipe(
          Effect.provide(makeHttpClientLive(fetchImpl, () => [], fetchImpl).pipe(Layer.provide(eventLayer))),
        ),
      ).pipe(Effect.fork);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
    }),
  );
  // Then cancellation preserves the event pair without reading the body.
  expect(canceled).toBe(true);
  expect(signal?.aborted).toBe(true);
  expect(events.map((event) => event._tag)).toEqual(["pre-http-call", "post-http-call"]);
  expect(events.find((event) => event._tag === "post-http-call")?.outcome).toBe("failure");
});
