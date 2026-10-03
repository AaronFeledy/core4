import { describe, expect, test } from "bun:test";
import { DateTime, Duration, Effect, Layer, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { EventService, type LandoEvent } from "@lando/sdk/services";
import {
  type HttpClientContractHarness,
  type HttpClientContractRequestPolicy,
  runHttpClientContract,
} from "@lando/sdk/test";

import { RequestPolicy, layerWith } from "@lando/http-client/live";
import { NetworkTrust, type ResolvedNetworkTrust } from "@lando/http-client/network-trust";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const SYSTEM_CA_SAMPLE = "-----BEGIN CERTIFICATE-----\nSYSTEM-ROOT-SAMPLE\n-----END CERTIFICATE-----";

const withPolicy = <A, E, R>(
  policy: HttpClientContractRequestPolicy,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(RequestPolicy, policy));

const originOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

/** Minimal in-memory Effect HttpClient for the contract suite. */
const makeMemoryHttpClient = (options: {
  readonly sources: Map<string, Uint8Array>;
  readonly events: LandoEvent[];
  readonly corruptStream?: boolean;
  readonly leakSecret?: boolean;
}): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    Effect.gen(function* () {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: "unsupported scheme" }),
          }),
        );
      }

      const href = url.href;
      const body = options.sources.get(href);
      const status = body === undefined ? 404 : 200;
      const timestamp = yield* DateTime.now;
      options.events.push({
        _tag: "pre-http-call",
        eventName: "pre-http-call",
        urlOrigin: originOf(href),
        timestamp,
      } as unknown as LandoEvent);
      options.events.push({
        _tag: "post-http-call",
        eventName: "post-http-call",
        urlOrigin: originOf(href),
        status,
        outcome: "success",
        durationMs: 0,
        timestamp,
        ...(options.leakSecret === true ? { leaked: "ULW-HTTP-SECRET-9f8e7d6c5b4a3" } : {}),
      } as unknown as LandoEvent);

      const bytes =
        options.corruptStream === true ? new TextEncoder().encode("corrupted") : (body ?? new Uint8Array());
      return HttpClientResponse.fromWeb(
        request,
        new Response(bytes, { status, headers: { "content-type": "application/octet-stream" } }),
      );
    }),
  );

describe("HttpClient contract suite", () => {
  test("in-memory Effect HttpClient satisfies the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const events: LandoEvent[] = [];
    const service = makeMemoryHttpClient({ sources, events });
    const harness: HttpClientContractHarness = {
      name: "MemoryHttpClient",
      service,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.sync(() => [...events]),
    };
    const result = await run(runHttpClientContract(harness));
    expect(result).toBeUndefined();
  });

  test("HttpClient layer (injected fetch + NetworkTrust) satisfies the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const events: LandoEvent[] = [];
    let lastInit: { url: string; proxy?: string; tls?: { ca?: ReadonlyArray<string> } } | undefined;
    let connectCount = 0;
    let offline = false;
    let interruptSignal: AbortSignal | undefined;
    let interruptAborted = false;
    let timeoutSignal: AbortSignal | undefined;
    let timeoutAborted = false;

    const fetchImpl = ((input: string | URL | Request, init?: unknown) => {
      const url = typeof input === "string" ? input : input.toString();
      if (offline) return Promise.reject(new Error("offline"));
      const requestInit = (init ?? {}) as {
        proxy?: string;
        signal?: AbortSignal;
        tls?: { ca?: ReadonlyArray<string> };
      };
      if (url === "https://contract.test/interrupt.bin") {
        interruptSignal = requestInit.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestInit.signal?.addEventListener("abort", () => {
            interruptAborted = true;
            reject(new Error("aborted"));
          });
        });
      }
      if (url === "https://contract.test/timeout-hang.bin") {
        timeoutSignal = requestInit.signal;
        const body = new ReadableStream<Uint8Array>({
          start: (_controller) => {
            requestInit.signal?.addEventListener("abort", () => {
              timeoutAborted = true;
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      lastInit = {
        url,
        ...(requestInit.proxy === undefined ? {} : { proxy: requestInit.proxy }),
        ...(requestInit.tls?.ca === undefined ? {} : { tls: { ca: requestInit.tls.ca } }),
      };
      const body = sources.get(url);
      if (body === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
      connectCount += 1;
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;

    const eventLayer = Layer.succeed(EventService, {
      publish: (event: LandoEvent) => Effect.sync(() => void events.push(event)),
      subscribe: () => Stream.empty,
      subscribeQueue: undefined,
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    } as never);

    const layer = layerWith({
      fetch: fetchImpl,
      systemCaPems: () => [SYSTEM_CA_SAMPLE],
      // NO_PROXY / loopback hosts use the direct transport; mirror fetch capture.
      direct: (url, init) => {
        lastInit = {
          url: url.href,
          ...(init.ca === undefined ? {} : { tls: { ca: [...init.ca] } }),
        };
        connectCount += 1;
        const body = sources.get(url.href);
        if (body === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    }).pipe(Layer.provide(eventLayer));

    const service = await run(
      Effect.provide(
        Effect.gen(function* () {
          return yield* HttpClient.HttpClient;
        }),
        layer,
      ) as Effect.Effect<HttpClient.HttpClient, never, never>,
    );

    const harness: HttpClientContractHarness<ResolvedNetworkTrust> = {
      name: "HttpClientLayer",
      service,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.sync(() => [...events]),
      withPolicy,
      trust: {
        make: (input) => ({
          proxy: input.proxy,
          caPems: input.caPems,
          trustHost: input.trustHost ?? true,
        }),
        withTrust: (trust, effect) => effect.pipe(Effect.provideService(NetworkTrust, trust)),
        lastInit: () => Effect.sync(() => lastInit),
        systemCaSample: SYSTEM_CA_SAMPLE,
      },
      offline: {
        withOffline: (effect) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              offline = true;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                offline = false;
              }),
          ),
        connectCount: () => Effect.sync(() => connectCount),
      },
      interruption: {
        run: () =>
          Effect.gen(function* () {
            const response = yield* service.get("https://contract.test/interrupt.bin");
            return yield* Stream.runDrain(response.stream);
          }),
        finalized: () => Effect.sync(() => interruptSignal?.aborted === true && interruptAborted),
      },
      timeout: {
        run: (timeoutMs) =>
          Effect.gen(function* () {
            const response = yield* service.get("https://contract.test/timeout-hang.bin");
            return yield* Stream.runDrain(response.stream).pipe(Effect.timeout(Duration.millis(timeoutMs)));
          }),
        reaped: () => Effect.sync(() => timeoutSignal?.aborted === true && timeoutAborted),
      },
    };
    const result = await run(runHttpClientContract(harness));
    expect(result).toBeUndefined();
  });

  test("a contributed Effect HttpClient implementation satisfies the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const events: LandoEvent[] = [];
    const service = makeMemoryHttpClient({ sources, events });
    const harness: HttpClientContractHarness = {
      name: "ContributedHttpClient",
      service,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.sync(() => [...events]),
    };
    const result = await run(runHttpClientContract(harness));
    expect(result).toBeUndefined();
  });
});

describe("HttpClient contract rejects weakened implementations", () => {
  test("an implementation that streams the wrong bytes fails the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const events: LandoEvent[] = [];
    const service = makeMemoryHttpClient({ sources, events, corruptStream: true });
    const harness: HttpClientContractHarness = {
      name: "RogueHttpClient",
      service,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.succeed([]),
    };
    const exit = await Effect.runPromiseExit(runHttpClientContract(harness));
    expect(exit._tag).toBe("Failure");
  });

  test("an implementation that leaks a secret into an event fails the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const events: LandoEvent[] = [];
    const service = makeMemoryHttpClient({ sources, events, leakSecret: true });
    const harness: HttpClientContractHarness = {
      name: "RogueRedaction",
      service,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.sync(() => [...events]),
    };
    const exit = await Effect.runPromiseExit(runHttpClientContract(harness));
    expect(exit._tag).toBe("Failure");
  });
});
