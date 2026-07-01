import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Duration, Effect, Exit, Fiber, Layer, type Scope, Stream } from "effect";

import type { HttpRequest, HttpStreamResponse } from "@lando/sdk/schema";
import type { GlobalConfig } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import { ConfigService, EventService, type LandoEvent } from "@lando/sdk/services";

import { HttpClientLive, makeHttpClientLive } from "../../src/http-client/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../../src/http-client/network-trust.ts";
import { HttpClient } from "../../src/http-client/service.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-http-client-"));
  tempDirs.push(dir);
  return dir;
};

const run = <A, E>(program: Effect.Effect<A, E, HttpClient | Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(HttpClientLive))));

const runExit = <A, E>(program: Effect.Effect<A, E, HttpClient | Scope.Scope>) =>
  Effect.runPromiseExit(Effect.scoped(program.pipe(Effect.provide(HttpClientLive))));

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array =>
  new Uint8Array(Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))));

const collectBody = (response: HttpStreamResponse & { readonly body: Stream.Stream<Uint8Array, unknown> }) =>
  Stream.runCollect(response.body).pipe(Effect.map(concatBytes));

const streamAndCollect = (request: HttpRequest) =>
  Effect.flatMap(HttpClient, (client) =>
    Effect.flatMap(client.stream(request), (response) =>
      Effect.map(collectBody(response), (body) => ({ body, status: response.status })),
    ),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

const captureEvents = () => {
  const events: LandoEvent[] = [];
  const layer = Layer.succeed(EventService, {
    publish: (event: LandoEvent) => Effect.sync(() => void events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: undefined,
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  } as never);
  return { layer, events: () => [...events] };
};

describe("HttpClientLive contract surface", () => {
  test("declares the SDK capabilities and a stable id", async () => {
    const info = await run(
      Effect.map(HttpClient, (client) => ({ id: client.id, caps: client.capabilities })),
    );
    expect(typeof info.id).toBe("string");
    expect(info.id.length).toBeGreaterThan(0);
    expect(info.caps.schemes).toContain("https");
    expect(info.caps.streaming).toBe(true);
    expect(info.caps.proxyAware).toBe(true);
    expect(info.caps.customCa).toBe(true);
  });

  test("request returns a buffered response with status and content length", async () => {
    const expected = new TextEncoder().encode("hello from loopback\n");
    const server = Bun.serve({
      fetch: () => new Response(expected, { headers: { "x-lando-test": "yes" }, status: 200 }),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const res = await run(
        Effect.flatMap(HttpClient, (client) =>
          client.request({ url: `http://127.0.0.1:${server.port}/artifact` }),
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers.some((h) => h.name.toLowerCase() === "x-lando-test" && h.value === "yes")).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("HttpClientLive streaming", () => {
  test("streams allowed file:// sources from disk", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.bin");
    const expected = new Uint8Array([0, 1, 2, 3, 254, 255]);
    await writeFile(file, expected);

    const result = await run(streamAndCollect({ url: pathToFileURL(file).href, allowFileSource: true }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expected);
  });

  test("rejects file:// sources without reading when not explicitly allowed", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.txt");
    await writeFile(file, "not read\n");

    const exit = await runExit(
      Effect.flatMap(HttpClient, (client) => client.stream({ url: pathToFileURL(file).href })),
    );
    const error = failureOf(exit) as { _tag: string };
    expect(error._tag).toBe("HttpRequestError");
    const content = await readFile(file, "utf8");
    expect(content).toBe("not read\n");
  });

  test("rejects unsupported schemes", async () => {
    const exit = await runExit(Effect.flatMap(HttpClient, (client) => client.stream({ url: "ftp://x" })));
    const error = failureOf(exit) as { _tag: string };
    expect(error._tag).toBe("HttpRequestError");
  });

  test("streams http:// response bodies from loopback fetch without buffering", async () => {
    const expected = new TextEncoder().encode("hello from loopback stream\n");
    const server = Bun.serve({
      fetch: () => new Response(expected, { status: 200 }),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const result = await run(streamAndCollect({ url: `http://127.0.0.1:${server.port}/artifact` }));
      expect(result.status).toBe(200);
      expect(result.body).toEqual(expected);
    } finally {
      server.stop(true);
    }
  });

  test("fails streaming when chunked body exceeds the overall timeout budget", async () => {
    let chunkCount = 0;
    const slowChunkedFetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              chunkCount += 1;
              if (chunkCount > 8) {
                controller.close();
                return;
              }
              controller.enqueue(new Uint8Array([1]));
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        streamAndCollect({ url: "https://timeout.test/trickle", timeoutMs: 35 }).pipe(
          Effect.provide(makeHttpClientLive(slowChunkedFetch)),
        ),
      ),
    );

    const error = failureOf(exit) as { _tag: string; message?: string };
    expect(error._tag).toBe("HttpRequestError");
    expect(error.message).toBe("request exceeded timeoutMs=35");
  });

  test("subtracts elapsed connection time from the streaming timeout budget", async () => {
    let chunkCount = 0;
    const delayedFetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            chunkCount += 1;
            if (chunkCount > 4) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array([chunkCount]));
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        streamAndCollect({ url: "https://timeout.test/elapsed", timeoutMs: 45 }).pipe(
          Effect.provide(makeHttpClientLive(delayedFetch)),
        ),
      ),
    );

    const error = failureOf(exit) as { _tag: string; message?: string };
    expect(error._tag).toBe("HttpRequestError");
    expect(error.message).toBe("request exceeded timeoutMs=45");
  });
});

describe("HttpClientLive network trust", () => {
  const CA_PEM = "-----BEGIN CERTIFICATE-----\nMOCKCA\n-----END CERTIFICATE-----";

  const captureFetch = (): {
    readonly fetchImpl: typeof fetch;
    readonly init: () => BunFetchRequestInit | undefined;
  } => {
    let captured: BunFetchRequestInit | undefined;
    const fetchImpl = ((_input: unknown, requestInit?: BunFetchRequestInit) => {
      captured = requestInit;
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }) as typeof fetch;
    return { fetchImpl, init: () => captured };
  };

  const drive = (
    fetchImpl: typeof fetch,
    request: HttpRequest,
    trust?: ResolvedNetworkTrust,
  ): Promise<void> => {
    const program = Effect.flatMap(HttpClient, (client) =>
      Effect.flatMap(client.stream(request), (res) => Stream.runDrain(res.body)),
    ).pipe(Effect.provide(makeHttpClientLive(fetchImpl)));
    const provided = trust === undefined ? program : program.pipe(Effect.provideService(NetworkTrust, trust));
    return Effect.runPromise(Effect.scoped(provided));
  };

  test("applies resolved proxy and CA trust to the fetch init", async () => {
    const capture = captureFetch();
    await drive(
      capture.fetchImpl,
      { url: "https://example.com/artifact" },
      { proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: [] }, caPems: [CA_PEM] },
    );
    expect(capture.init()?.proxy).toBe("http://proxy:3128");
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("bypasses the proxy for NO_PROXY hosts while still applying the CA", async () => {
    const capture = captureFetch();
    await drive(
      capture.fetchImpl,
      { url: "https://example.com/artifact" },
      {
        proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: ["example.com"] },
        caPems: [CA_PEM],
      },
    );
    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("leaves the fetch init free of proxy/tls when no NetworkTrust is provided", async () => {
    const capture = captureFetch();
    await drive(capture.fetchImpl, { url: "https://example.com/artifact" });
    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toBeUndefined();
  });

  test("self-resolves proxy and CA from env when ConfigService.load fails", async () => {
    const dir = await makeTempDir();
    const caPath = join(dir, "env-only.pem");
    const envCaPem = "-----BEGIN CERTIFICATE-----\nFROMENV\n-----END CERTIFICATE-----";
    await writeFile(caPath, envCaPem);

    const prevHttpProxy = process.env.HTTP_PROXY;
    const prevCaCerts = process.env.LANDO_NETWORK_CA_CERTS;
    process.env.HTTP_PROXY = "http://env-proxy:8080";
    process.env.LANDO_NETWORK_CA_CERTS = JSON.stringify([caPath]);

    const configLayer = Layer.succeed(ConfigService, {
      load: Effect.fail(new Error("global config unavailable")),
      get: () => Effect.die("unused"),
    } as never);

    const capture = captureFetch();
    const program = Effect.flatMap(HttpClient, (client) =>
      Effect.flatMap(client.stream({ url: "https://example.com/artifact" }), (res) =>
        Stream.runDrain(res.body),
      ),
    ).pipe(Effect.provide(Layer.mergeAll(makeHttpClientLive(capture.fetchImpl), configLayer)));

    try {
      await Effect.runPromise(Effect.scoped(program));
      expect(capture.init()?.proxy).toBe("http://env-proxy:8080");
      expect(capture.init()?.tls).toEqual({ ca: [envCaPem] });
    } finally {
      if (prevHttpProxy === undefined) process.env.HTTP_PROXY = undefined;
      else process.env.HTTP_PROXY = prevHttpProxy;
      if (prevCaCerts === undefined) process.env.LANDO_NETWORK_CA_CERTS = undefined;
      else process.env.LANDO_NETWORK_CA_CERTS = prevCaCerts;
    }
  });

  test("self-resolves proxy and CA from ConfigService when NetworkTrust is absent", async () => {
    const dir = await makeTempDir();
    const caPath = join(dir, "custom.pem");
    const CA_PEM = "-----BEGIN CERTIFICATE-----\nFROMCONFIG\n-----END CERTIFICATE-----";
    await writeFile(caPath, CA_PEM);

    const config: GlobalConfig = {
      defaultProviderId: ProviderId.make("lando"),
      telemetry: { enabled: false },
      network: {
        proxy: { https: "http://config-proxy:3128", noProxy: [] },
        ca: { certs: [caPath], trustHost: true },
      },
    };
    const configLayer = Layer.succeed(ConfigService, {
      load: Effect.succeed(config),
      get: (key: keyof GlobalConfig) => Effect.map(Effect.succeed(config), (c) => c[key]),
    } as never);

    const capture = captureFetch();
    const program = Effect.flatMap(HttpClient, (client) =>
      Effect.flatMap(client.stream({ url: "https://example.com/artifact" }), (res) =>
        Stream.runDrain(res.body),
      ),
    ).pipe(Effect.provide(Layer.mergeAll(makeHttpClientLive(capture.fetchImpl), configLayer)));

    await Effect.runPromise(Effect.scoped(program));
    expect(capture.init()?.proxy).toBe("http://config-proxy:3128");
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("fails before fetch when a configured CA path is unreadable", async () => {
    const missing = join(await makeTempDir(), "missing-ca.pem");
    const config: GlobalConfig = {
      defaultProviderId: ProviderId.make("lando"),
      telemetry: { enabled: false },
      network: { ca: { certs: [missing], trustHost: true } },
    };
    const configLayer = Layer.succeed(ConfigService, {
      load: Effect.succeed(config),
      get: (key: keyof GlobalConfig) => Effect.map(Effect.succeed(config), (c) => c[key]),
    } as never);

    let fetchCalled = false;
    const fetchImpl = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }));
    }) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) => client.stream({ url: "https://example.com/artifact" })).pipe(
          Effect.provide(Layer.mergeAll(makeHttpClientLive(fetchImpl), configLayer)),
        ),
      ),
    );

    const error = failureOf(exit) as { _tag: string; message?: string };
    expect(error._tag).toBe("HttpRequestError");
    expect(error.message).toContain(missing);
    expect(fetchCalled).toBe(false);
  });

  test("fails before fetch when LANDO_NETWORK_CA_CERTS is invalid JSON", async () => {
    const prevCaCerts = process.env.LANDO_NETWORK_CA_CERTS;
    process.env.LANDO_NETWORK_CA_CERTS = "not-valid-json";

    const config: GlobalConfig = {
      defaultProviderId: ProviderId.make("lando"),
      telemetry: { enabled: false },
    };
    const configLayer = Layer.succeed(ConfigService, {
      load: Effect.succeed(config),
      get: (key: keyof GlobalConfig) => Effect.map(Effect.succeed(config), (c) => c[key]),
    } as never);

    let fetchCalled = false;
    const fetchImpl = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }));
    }) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) => client.stream({ url: "https://example.com/artifact" })).pipe(
          Effect.provide(Layer.mergeAll(makeHttpClientLive(fetchImpl), configLayer)),
        ),
      ),
    );

    try {
      const error = failureOf(exit) as { _tag: string; message?: string };
      expect(error._tag).toBe("HttpRequestError");
      expect(error.message).toContain("LANDO_NETWORK_CA_CERTS");
      expect(fetchCalled).toBe(false);
    } finally {
      if (prevCaCerts === undefined) process.env.LANDO_NETWORK_CA_CERTS = undefined;
      else process.env.LANDO_NETWORK_CA_CERTS = prevCaCerts;
    }
  });
});

describe("HttpClientLive lifecycle events", () => {
  const serveOnce = (payload: Uint8Array) =>
    ((_input: unknown) => Promise.resolve(new Response(payload, { status: 200 }))) as unknown as typeof fetch;

  test("publishes redacted pre/post-http-call events with scheme+host origin", async () => {
    const secret = "SECRET-abc123";
    const url = `https://user:${secret}@evt.test/r?token=${secret}`;
    const cap = captureEvents();
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) =>
          client.request({ url, callerId: `caller-${secret}`, redactionTokens: [secret] }),
        ).pipe(
          Effect.provide(makeHttpClientLive(serveOnce(new Uint8Array([1]))).pipe(Layer.provide(cap.layer))),
        ),
      ),
    );
    const events = cap.events();
    expect(events.some((e) => e._tag === "pre-http-call")).toBe(true);
    expect(events.some((e) => e._tag === "post-http-call")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
    for (const e of events) {
      expect((e as { urlOrigin?: string }).urlOrigin).toBe("https://evt.test");
    }
  });

  test("stamps onBehalfOf on events when provided", async () => {
    const cap = captureEvents();
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) =>
          client.request({ url: "https://evt.test/r", onBehalfOf: "downloader" }),
        ).pipe(
          Effect.provide(makeHttpClientLive(serveOnce(new Uint8Array([1]))).pipe(Layer.provide(cap.layer))),
        ),
      ),
    );
    const events = cap.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => (e as { onBehalfOf?: string }).onBehalfOf === "downloader")).toBe(true);
  });

  test("post-http-call reports failure when the response body stream errors during read", async () => {
    const cap = captureEvents();
    const failBodyFetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("stream read failed"));
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        streamAndCollect({ url: "https://evt.test/body-fail" }).pipe(
          Effect.provide(makeHttpClientLive(failBodyFetch).pipe(Layer.provide(cap.layer))),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);

    const posts = cap.events().filter((e) => e._tag === "post-http-call") as ReadonlyArray<{
      outcome?: string;
      status?: number;
      failureDetail?: string;
    }>;
    expect(posts.length).toBe(1);
    expect(posts[0]?.outcome).toBe("failure");
    expect(posts[0]?.status).toBe(200);
    expect(posts[0]?.failureDetail).toContain("stream read failed");
  });

  test("post-http-call success is emitted only after the body stream is wired", async () => {
    const cap = captureEvents();
    await Effect.runPromise(
      Effect.scoped(
        streamAndCollect({ url: "https://evt.test/ok" }).pipe(
          Effect.provide(makeHttpClientLive(serveOnce(new Uint8Array([9]))).pipe(Layer.provide(cap.layer))),
        ),
      ),
    );
    const post = cap.events().find((e) => e._tag === "post-http-call") as { outcome?: string } | undefined;
    expect(post?.outcome).toBe("success");
  });

  test("post-http-call reports failure when body streaming is interrupted", async () => {
    const cap = captureEvents();
    const hangingBodyFetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              controller.enqueue(new Uint8Array([1]));
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* streamAndCollect({ url: "https://evt.test/interrupted" }).pipe(Effect.fork);
          yield* Effect.sleep(Duration.millis(10));
          yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(makeHttpClientLive(hangingBodyFetch).pipe(Layer.provide(cap.layer)))),
      ),
    );

    const posts = cap.events().filter((e) => e._tag === "post-http-call") as ReadonlyArray<{
      outcome?: string;
      status?: number;
      failureDetail?: string;
    }>;
    expect(posts.length).toBe(1);
    expect(posts[0]?.outcome).toBe("failure");
    expect(posts[0]?.status).toBe(200);
    expect(posts[0]?.failureDetail).toBe("body-read-interrupted");
  });

  test("post-http-call reports a failure outcome without leaking the URL", async () => {
    const secret = "FAILSECRET-xyz";
    const url = `https://user:${secret}@evt.test/missing?token=${secret}`;
    const cap = captureEvents();
    const failFetch = (() =>
      Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch;
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) => client.request({ url, redactionTokens: [secret] })).pipe(
          Effect.provide(makeHttpClientLive(failFetch).pipe(Layer.provide(cap.layer))),
        ),
      ),
    );
    const post = cap.events().find((e) => e._tag === "post-http-call") as
      | { outcome?: string; status?: number; urlOrigin?: string }
      | undefined;
    expect(post?.outcome).toBe("success");
    expect(post?.status).toBe(500);
    expect(post?.urlOrigin).toBe("https://evt.test");
    expect(JSON.stringify(cap.events())).not.toContain(secret);
  });

  test("request failures use redacted-origin messages", async () => {
    const secret = "ERRSECRET-abc";
    const url = `https://user:${secret}@evt.test/missing?token=${secret}`;
    const failFetch = (() => Promise.reject(new Error(""))) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) => client.request({ url, redactionTokens: [secret] })).pipe(
          Effect.provide(makeHttpClientLive(failFetch)),
        ),
      ),
    );

    const error = failureOf(exit) as { message?: string; urlOrigin?: string };
    expect(error.message).toBe("Failed to fetch https://evt.test");
    expect(error.urlOrigin).toBe("https://evt.test");
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
