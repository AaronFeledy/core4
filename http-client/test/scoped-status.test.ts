import { expect, test } from "bun:test";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { layerWith } from "../src/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../src/network-trust.ts";

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
  // When a status-only request is opened.
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return yield* client.get(url);
    }).pipe(
      Effect.provide(
        layerWith({
          fetch: fetchImpl,
          systemCaPems: () => ["host-ca"],
          direct: async (_url, init) => {
            direct = true;
            captured = { tls: { ca: [...(init.ca ?? [])] } };
            return new Response(null, { status: 204 });
          },
        }),
      ),
      Effect.provideService(NetworkTrust, trust),
    ),
  );
  // Then proxy policy changes routing only, not certificate verification.
  expect(direct ? "direct" : captured?.proxy).toBe(proxy);
  expect(captured?.tls).toEqual({ ca: ["host-ca", "custom-ca"] });
});

test.each([false, true])(
  "pairs events once and aborts when scoped request closes consumed=%s",
  async (consume) => {
    // Given an observable response reader and request signal.
    const events: LandoEvent[] = [];
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
        signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
          { status: 503 },
        );
      },
      { preconnect: fetch.preconnect },
    );
    const eventLayer = Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.never,
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    );
    // When the caller reads headers and optionally body under a Scope (parent finalizer pairs post).
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const scoped = HttpClient.withScope(client);
          const response = yield* scoped.get("http://localhost/status");
          if (consume) yield* Stream.runDrain(response.stream);
        }).pipe(
          Effect.provide(
            layerWith({ fetch: fetchImpl, systemCaPems: () => [], direct: fetchImpl }).pipe(
              Layer.provide(eventLayer),
            ),
          ),
        ),
      ),
    );
    // Then even a non-2xx status is a successful transport with exactly one pair, and scope aborts.
    expect(signal?.aborted).toBe(true);
    expect(events.map((event) => event._tag)).toEqual(["pre-http-call", "post-http-call"]);
    expect(events.find((event) => event._tag === "post-http-call")).toMatchObject({
      outcome: "success",
      status: 503,
    });
  },
);

test("aborts and pairs events when a header-only scoped request is interrupted before body read", async () => {
  // Given a stream whose headers are available and body is never consumed.
  const events: LandoEvent[] = [];
  let signal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream({
          pull() {
            /* keep open */
          },
        }),
      );
    },
    { preconnect: fetch.preconnect },
  );
  const eventLayer = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.never,
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  );
  // When interrupted after opening the response under a Scope without body consumption.
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // Parent live.ts also installs a Scope finalizer when Scope is present.
          yield* client.get("http://localhost/status");
          yield* Deferred.succeed(ready, undefined);
          yield* Effect.never;
        }).pipe(
          Effect.provide(
            layerWith({ fetch: fetchImpl, systemCaPems: () => [], direct: fetchImpl }).pipe(
              Layer.provide(eventLayer),
            ),
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
    }),
  );
  // Then scope interruption aborts the request; post fires from Scope finalizer as failure
  // because body was never read through observeResponse.
  expect(signal?.aborted).toBe(true);
  expect(events.map((event) => event._tag)).toEqual(["pre-http-call", "post-http-call"]);
  const post = events.find((event) => event._tag === "post-http-call");
  expect(post).toBeDefined();
  expect(post?.outcome).toBe("failure");
});
