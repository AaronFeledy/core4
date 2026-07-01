import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Duration, Effect, Layer, Stream } from "effect";

import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import type { HttpClientCapabilities, HttpRequest } from "@lando/sdk/schema";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { type HttpClientContractHarness, runHttpClientContract } from "@lando/sdk/test";

import { makeHttpClientLive } from "../../src/http-client/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../../src/http-client/network-trust.ts";
import { HttpClient, type HttpClientShape } from "../../src/http-client/service.ts";
import { makeTestHttpClient } from "../../src/testing/http-client.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const CONTRIBUTED_CAPABILITIES: HttpClientCapabilities = {
  schemes: ["https", "http"],
  streaming: true,
  upload: false,
  customCa: true,
  proxyAware: true,
};

const SYSTEM_CA_SAMPLE = "-----BEGIN CERTIFICATE-----\nSYSTEM-ROOT-SAMPLE\n-----END CERTIFICATE-----";

describe("HttpClient contract suite", () => {
  test("TestHttpClient (in-memory) satisfies the contract", async () => {
    const handle = makeTestHttpClient({ systemCaPems: [SYSTEM_CA_SAMPLE] });
    const harness: HttpClientContractHarness<ResolvedNetworkTrust> = {
      name: "TestHttpClient",
      service: handle.service,
      serveSource: (url, bytes) => Effect.sync(() => handle.serve(url, bytes)),
      events: () => Effect.sync(() => handle.events()),
      trust: {
        make: (input) => ({
          proxy: input.proxy,
          caPems: input.caPems,
          trustHost: input.trustHost ?? true,
        }),
        withTrust: (trust, effect) => handle.withTrust(trust, effect),
        lastInit: () => Effect.sync(() => handle.lastInit()),
        systemCaSample: SYSTEM_CA_SAMPLE,
      },
      offline: {
        withOffline: (effect) => handle.withOffline(effect),
        connectCount: () => Effect.sync(() => handle.connectCount()),
      },
      timeout: {
        run: (timeoutMs) => {
          const url = "https://contract.test/hang.bin";
          handle.serveHang(url);
          return handle.service.request({ url, timeoutMs });
        },
        reaped: () => Effect.sync(() => handle.pendingHangs() === 0),
      },
    };
    const result = await run(runHttpClientContract(harness));
    expect(result).toBeUndefined();
  });

  test("TestHttpClient times out while draining a streaming body", async () => {
    const handle = makeTestHttpClient();
    const url = "https://contract.test/body-hang.bin";
    handle.serveBodyHang(url);

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.timeoutFail(
          Effect.flatMap(handle.service.stream({ url, timeoutMs: 10 }), (response) =>
            Stream.runDrain(response.body),
          ),
          { duration: Duration.millis(100), onTimeout: () => new Error("test body did not time out") },
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : undefined;
    expect(failure?._tag).toBe("Some");
    const error = failure?._tag === "Some" ? (failure.value as { readonly message?: string }) : undefined;
    expect(error?.message).toBe("request exceeded timeoutMs=10");
  });

  test("HttpClientLive (injected fetch + NetworkTrust) satisfies the contract", async () => {
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

    const layer = makeHttpClientLive(fetchImpl, () => [SYSTEM_CA_SAMPLE]).pipe(Layer.provide(eventLayer));
    const service = await run(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            return yield* HttpClient;
          }),
          layer,
        ),
      ) as Effect.Effect<HttpClientShape, never, never>,
    );

    const harness: HttpClientContractHarness<ResolvedNetworkTrust> = {
      name: "HttpClientLive",
      service,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.sync(() => [...events]),
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
          Effect.flatMap(service.stream({ url: "https://contract.test/interrupt.bin" }), (response) =>
            Stream.runDrain(response.body),
          ),
        finalized: () => Effect.sync(() => interruptSignal?.aborted === true && interruptAborted),
      },
      timeout: {
        run: (timeoutMs) =>
          Effect.flatMap(
            service.stream({ url: "https://contract.test/timeout-hang.bin", timeoutMs }),
            (response) => Stream.runDrain(response.body),
          ),
        reaped: () => Effect.sync(() => timeoutSignal?.aborted === true && timeoutAborted),
      },
    };
    const result = await run(runHttpClientContract(harness));
    expect(result).toBeUndefined();
  });

  test("a contributed HttpClient implementation satisfies the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const events: LandoEvent[] = [];
    const httpScheme = (url: string): boolean => /^https?:$/u.test(new URL(url).protocol);
    const origin = (url: string): string => {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    };
    const emitEvents = (request: HttpRequest, status: number) => {
      events.push({
        _tag: "pre-http-call",
        eventName: "pre-http-call",
        urlOrigin: origin(request.url),
        timestamp: DateTime.unsafeMake(Date.now()),
      } as unknown as LandoEvent);
      events.push({
        _tag: "post-http-call",
        eventName: "post-http-call",
        urlOrigin: origin(request.url),
        status,
        outcome: "success",
        durationMs: 0,
        timestamp: DateTime.unsafeMake(Date.now()),
      } as unknown as LandoEvent);
    };
    const contributed: HttpClientShape = {
      id: "contributed-http",
      capabilities: CONTRIBUTED_CAPABILITIES,
      request: (request) =>
        Effect.gen(function* () {
          if (!httpScheme(request.url)) {
            return yield* Effect.fail(
              new HttpRequestError({ message: "unsupported scheme", urlOrigin: request.url }),
            );
          }
          const body = sources.get(request.url);
          emitEvents(request, body === undefined ? 404 : 200);
          return { status: body === undefined ? 404 : 200, headers: [], contentLength: body?.length ?? 0 };
        }),
      stream: (request) =>
        Effect.gen(function* () {
          if (!httpScheme(request.url)) {
            return yield* Effect.fail(
              new HttpRequestError({ message: "unsupported scheme", urlOrigin: request.url }),
            );
          }
          const body = sources.get(request.url) ?? new Uint8Array();
          emitEvents(request, sources.has(request.url) ? 200 : 404);
          return {
            status: sources.has(request.url) ? 200 : 404,
            headers: [],
            body: Stream.fromIterable([body]),
          };
        }),
      upload: (request) => Effect.fail(new HttpUploadError({ message: "no upload", urlOrigin: request.url })),
    };
    const harness: HttpClientContractHarness = {
      name: "ContributedHttpClient",
      service: contributed,
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
    const rogue: HttpClientShape = {
      id: "rogue-bytes",
      capabilities: CONTRIBUTED_CAPABILITIES,
      request: (_request) => Effect.sync(() => ({ status: 200, headers: [], contentLength: 0 })),
      stream: () =>
        Effect.sync(() => ({
          status: 200,
          headers: [],
          body: Stream.fromIterable([new TextEncoder().encode("corrupted")]),
        })),
      upload: (request) => Effect.fail(new HttpUploadError({ message: "no upload", urlOrigin: request.url })),
    };
    const harness: HttpClientContractHarness = {
      name: "RogueHttpClient",
      service: rogue,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.succeed([]),
    };
    const exit = await Effect.runPromiseExit(runHttpClientContract(harness));
    expect(exit._tag).toBe("Failure");
  });

  test("an implementation that leaks a secret into an event fails the contract", async () => {
    const sources = new Map<string, Uint8Array>();
    const leaked: LandoEvent[] = [];
    const rogue: HttpClientShape = {
      id: "rogue-redaction",
      capabilities: CONTRIBUTED_CAPABILITIES,
      request: (request) =>
        Effect.sync(() => {
          if (request.redactionTokens !== undefined && request.redactionTokens.length > 0) {
            leaked.push({
              _tag: "post-http-call",
              eventName: "post-http-call",
              urlOrigin: "https://x.test",
              outcome: "success",
              leaked: request.redactionTokens[0],
            } as unknown as LandoEvent);
          }
          const body = sources.get(request.url);
          return { status: body === undefined ? 404 : 200, headers: [], contentLength: body?.length ?? 0 };
        }),
      stream: (request) =>
        Effect.sync(() => {
          const body = sources.get(request.url) ?? new Uint8Array();
          return {
            status: sources.has(request.url) ? 200 : 404,
            headers: [],
            body: Stream.fromIterable([body]),
          };
        }),
      upload: (request) => Effect.fail(new HttpUploadError({ message: "no upload", urlOrigin: request.url })),
    };
    const harness: HttpClientContractHarness = {
      name: "RogueRedaction",
      service: rogue,
      serveSource: (url, bytes) => Effect.sync(() => void sources.set(url, bytes)),
      events: () => Effect.sync(() => [...leaked]),
    };
    const exit = await Effect.runPromiseExit(runHttpClientContract(harness));
    expect(exit._tag).toBe("Failure");
  });
});
