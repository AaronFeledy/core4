import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Stream, Tracer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { ConfigError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import { ConfigService, EventService, type LandoEvent } from "@lando/sdk/services";

import { RequestPolicy, type RequestPolicyShape, layer, layerWith } from "../src/live.ts";
import { NetworkTrust, type ResolvedNetworkTrust } from "../src/network-trust.ts";

const tempDirs: string[] = [];
const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "LANDO_NETWORK_CA_CERTS"] as const;
const envSnapshot = new Map<string, string | undefined>();

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  for (const key of envKeys) {
    if (!envSnapshot.has(key)) continue;
    const prev = envSnapshot.get(key);
    envSnapshot.delete(key);
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

const stashEnv = (key: (typeof envKeys)[number], value: string) => {
  if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
  process.env[key] = value;
};

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-http-client-"));
  tempDirs.push(dir);
  return dir;
};

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array =>
  new Uint8Array(Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))));

const policy =
  (shape: RequestPolicyShape) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.provideService(RequestPolicy, shape));

/** get + drain body so post-http-call completes via observeResponse body lifecycle. */
const getCollect = Effect.fnUntraced(
  function* (url: string, _shape: RequestPolicyShape = {}) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    const body = yield* Stream.runCollect(response.stream);
    return { status: response.status, body: concatBytes(body), headers: response.headers };
  },
  (effect, _url, shape = {}) => effect.pipe(policy(shape)),
);

const run = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  clientLayer: Layer.Layer<HttpClient.HttpClient> = layer,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(clientLayer)));

const runExit = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  clientLayer: Layer.Layer<HttpClient.HttpClient> = layer,
) => Effect.runPromiseExit(program.pipe(Effect.provide(clientLayer)));

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

const captureEvents = () => {
  const events: LandoEvent[] = [];
  const layerEvents = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event: LandoEvent) => Effect.sync(() => void events.push(event)),
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.never,
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  );
  return { layer: layerEvents, events: () => [...events] };
};

const isHttpClientError = (value: unknown): value is HttpClientError.HttpClientError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  (value as { _tag: string })._tag === "HttpClientError";

const transportCause = (error: unknown): unknown => {
  if (!isHttpClientError(error)) return error;
  const reason = error.reason;
  return reason._tag === "TransportError" ? reason.cause : reason;
};

describe("HttpClient layer surface", () => {
  test("get returns status and response headers", async () => {
    const expected = new TextEncoder().encode("hello from loopback\n");
    const server = Bun.serve({
      fetch: () => new Response(expected, { headers: { "x-lando-test": "yes" }, status: 200 }),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const res = await run(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.get(`http://127.0.0.1:${server.port}/artifact`);
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers["x-lando-test"]).toBe("yes");
    } finally {
      server.stop(true);
    }
  });

  test("head returns status without requiring body consumption", async () => {
    const server = Bun.serve({
      fetch: () => new Response("ignored", { status: 200, headers: { "x-head": "1" } }),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const res = await run(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.head(`http://127.0.0.1:${server.port}/artifact`);
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers["x-head"]).toBe("1");
    } finally {
      server.stop(true);
    }
  });
});

describe("HttpClient streaming", () => {
  test("streams allowed file:// sources from disk", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.bin");
    const expected = new Uint8Array([0, 1, 2, 3, 254, 255]);
    await writeFile(file, expected);

    const result = await run(getCollect(pathToFileURL(file).href, { allowFileSource: true }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expected);
  });

  test("fails file:// body reads when Effect.timeout exhausts during body consumption", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.bin");
    await writeFile(file, new Uint8Array([1, 2, 3]));

    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(pathToFileURL(file).href);
        yield* Effect.sleep(Duration.millis(25));
        return yield* Stream.runCollect(response.stream);
      }).pipe(policy({ allowFileSource: true }), Effect.timeout(Duration.millis(10))),
    );

    const error = failureOf(exit) as { readonly _tag: string };
    expect(error._tag).toBe("TimeoutError");
  });

  test("rejects file:// sources without reading when not explicitly allowed", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "artifact.txt");
    await writeFile(file, "not read\n");

    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get(pathToFileURL(file).href);
      }),
    );
    const error = failureOf(exit);
    expect(isHttpClientError(error)).toBe(true);
    const content = await readFile(file, "utf8");
    expect(content).toBe("not read\n");
  });

  test("rejects unsupported schemes", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get("ftp://x");
      }),
    );
    const error = failureOf(exit);
    expect(isHttpClientError(error)).toBe(true);
  });

  test("streams http:// response bodies from loopback fetch without buffering", async () => {
    const expected = new TextEncoder().encode("hello from loopback stream\n");
    const server = Bun.serve({
      fetch: () => new Response(expected, { status: 200 }),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const result = await run(getCollect(`http://127.0.0.1:${server.port}/artifact`));
      expect(result.status).toBe(200);
      expect(result.body).toEqual(expected);
    } finally {
      server.stop(true);
    }
  });

  test("fails when chunked body exceeds Effect.timeout on the full get+body operation", async () => {
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

    const exit = await runExit(
      getCollect("https://timeout.test/trickle").pipe(Effect.timeout(Duration.millis(35))),
      layerWith({ fetch: slowChunkedFetch }),
    );

    const error = failureOf(exit) as { _tag: string };
    expect(error._tag).toBe("TimeoutError");
  });

  test("Effect.timeout covers connection delay plus body drain on the full operation", async () => {
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

    const exit = await runExit(
      getCollect("https://timeout.test/elapsed").pipe(Effect.timeout(Duration.millis(45))),
      layerWith({ fetch: delayedFetch }),
    );

    const error = failureOf(exit) as { _tag: string };
    expect(error._tag).toBe("TimeoutError");
  });

  test("does not open a connection after Effect.timeout fires during pre-call setup", async () => {
    const events: LandoEvent[] = [];
    const slowPreEventLayer = Layer.succeed(
      EventService,
      EventService.of({
        publish: (event: LandoEvent) =>
          event._tag === "pre-http-call"
            ? Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20))).pipe(
                Effect.andThen(Effect.sync(() => void events.push(event))),
              )
            : Effect.sync(() => void events.push(event)),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.never,
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    );
    let fetchCalled = false;
    const fetchImpl = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
    }) as unknown as typeof fetch;

    const exit = await runExit(
      getCollect("https://timeout.test/setup-elapsed").pipe(Effect.timeout(Duration.millis(5))),
      layerWith({ fetch: fetchImpl }).pipe(Layer.provide(slowPreEventLayer)),
    );

    const error = failureOf(exit) as { readonly _tag: string };
    expect(error._tag).toBe("TimeoutError");
    expect(fetchCalled).toBe(false);
  });
});

describe("HttpClient network trust", () => {
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
    url: string,
    trust?: ResolvedNetworkTrust,
    systemCaPems: ReadonlyArray<string> = [],
  ): Promise<void> => {
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(url);
      yield* Stream.runDrain(response.stream);
    }).pipe(
      Effect.provide(
        layerWith({
          fetch: fetchImpl,
          systemCaPems: () => systemCaPems,
          direct: (requestUrl, init) =>
            fetchImpl(requestUrl, {
              ...init,
              ...(init.ca === undefined ? {} : { tls: { ca: [...init.ca] } }),
            }),
        }),
      ),
    );
    const provided = trust === undefined ? program : program.pipe(Effect.provideService(NetworkTrust, trust));
    return Effect.runPromise(provided);
  };

  test("applies resolved proxy and CA trust to the fetch init", async () => {
    const capture = captureFetch();
    await drive(capture.fetchImpl, "https://example.com/artifact", {
      proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: [] },
      caPems: [CA_PEM],
      trustHost: true,
    });
    expect(capture.init()?.proxy).toBe("http://proxy:3128");
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("bypasses the proxy for NO_PROXY hosts while still applying the CA", async () => {
    const capture = captureFetch();
    await drive(capture.fetchImpl, "https://example.com/artifact", {
      proxy: { http: "http://proxy:3128", https: "http://proxy:3128", noProxy: ["example.com"] },
      caPems: [CA_PEM],
      trustHost: true,
    });
    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("merges host default roots with the custom CA when trustHost is enabled", async () => {
    const capture = captureFetch();
    const systemRoot = "-----BEGIN CERTIFICATE-----\nHOST-ROOT\n-----END CERTIFICATE-----";
    await drive(
      capture.fetchImpl,
      "https://example.com/artifact",
      { proxy: { noProxy: [] }, caPems: [CA_PEM], trustHost: true },
      [systemRoot],
    );
    expect(capture.init()?.tls).toEqual({ ca: [systemRoot, CA_PEM] });
  });

  test("uses only the custom CA and drops host default roots when trustHost is disabled", async () => {
    const capture = captureFetch();
    const systemRoot = "-----BEGIN CERTIFICATE-----\nHOST-ROOT\n-----END CERTIFICATE-----";
    await drive(
      capture.fetchImpl,
      "https://example.com/artifact",
      { proxy: { noProxy: [] }, caPems: [CA_PEM], trustHost: false },
      [systemRoot],
    );
    expect(capture.init()?.tls).toEqual({ ca: [CA_PEM] });
  });

  test("leaves the fetch init free of proxy/tls when no NetworkTrust is provided", async () => {
    const capture = captureFetch();
    await drive(capture.fetchImpl, "https://example.com/artifact");
    expect(capture.init()?.proxy).toBeUndefined();
    expect(capture.init()?.tls).toBeUndefined();
  });

  test("self-resolves proxy and CA from env when ConfigService.load fails", async () => {
    const dir = await makeTempDir();
    const caPath = join(dir, "env-only.pem");
    const envCaPem = "-----BEGIN CERTIFICATE-----\nFROMENV\n-----END CERTIFICATE-----";
    await writeFile(caPath, envCaPem);

    stashEnv("HTTP_PROXY", "http://env-proxy:8080");
    stashEnv("LANDO_NETWORK_CA_CERTS", JSON.stringify([caPath]));

    const configLayer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.fail(new ConfigError({ message: "global config unavailable" })),
        get: () => Effect.die("unused"),
      }),
    );

    const capture = captureFetch();
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("https://example.com/artifact");
      yield* Stream.runDrain(response.stream);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerWith({ fetch: capture.fetchImpl, systemCaPems: () => [] }), configLayer),
      ),
    );

    await Effect.runPromise(program);
    expect(capture.init()?.proxy).toBe("http://env-proxy:8080");
    expect(capture.init()?.tls).toEqual({ ca: [envCaPem] });
  });

  test("self-resolves proxy and CA from ConfigService when NetworkTrust is absent", async () => {
    const dir = await makeTempDir();
    const caPath = join(dir, "custom.pem");
    const fromConfig = "-----BEGIN CERTIFICATE-----\nFROMCONFIG\n-----END CERTIFICATE-----";
    await writeFile(caPath, fromConfig);

    const config: GlobalConfig = {
      defaultProviderId: ProviderId.make("lando"),
      telemetry: { enabled: false },
      allowLoadOutsideRoot: false,
      loadMaxFileBytes: 1_048_576,
      loadMaxFilesPerExpression: 16,
      loadMaxRecursionDepth: 4,
      network: {
        proxy: { https: "http://config-proxy:3128", noProxy: [], injectIntoServices: false },
        ca: { certs: [caPath], trustHost: true, injectIntoServices: true },
      },
    };
    const configLayer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.map(Effect.succeed(config), (c) => c[key]),
      }),
    );

    const capture = captureFetch();
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("https://example.com/artifact");
      yield* Stream.runDrain(response.stream);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerWith({ fetch: capture.fetchImpl, systemCaPems: () => [] }), configLayer),
      ),
    );

    await Effect.runPromise(program);
    expect(capture.init()?.proxy).toBe("http://config-proxy:3128");
    expect(capture.init()?.tls).toEqual({ ca: [fromConfig] });
  });

  test("fails before fetch when a configured CA path is unreadable", async () => {
    const missing = join(await makeTempDir(), "missing-ca.pem");
    const config: GlobalConfig = {
      defaultProviderId: ProviderId.make("lando"),
      telemetry: { enabled: false },
      allowLoadOutsideRoot: false,
      loadMaxFileBytes: 1_048_576,
      loadMaxFilesPerExpression: 16,
      loadMaxRecursionDepth: 4,
      network: { ca: { certs: [missing], trustHost: true, injectIntoServices: true } },
    };
    const configLayer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.map(Effect.succeed(config), (c) => c[key]),
      }),
    );

    let fetchCalled = false;
    const fetchImpl = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }));
    }) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get("https://example.com/artifact");
      }).pipe(Effect.provide(Layer.mergeAll(layerWith({ fetch: fetchImpl }), configLayer))),
    );

    const error = failureOf(exit);
    expect(isHttpClientError(error)).toBe(true);
    const cause = transportCause(error) as {
      _tag?: string;
      message?: string;
      remediation?: string;
    };
    expect(cause._tag).toBe("HttpTrustError");
    expect(cause.message).toContain(missing);
    expect(cause.remediation).toContain("network.ca.certs");
    expect(cause.remediation).toContain("LANDO_NETWORK_CA_CERTS");
    expect(cause.remediation).toContain("security.ca");
    expect(fetchCalled).toBe(false);
  });

  test("fails before fetch when LANDO_NETWORK_CA_CERTS is invalid JSON", async () => {
    stashEnv("LANDO_NETWORK_CA_CERTS", "not-valid-json");

    const config: GlobalConfig = {
      defaultProviderId: ProviderId.make("lando"),
      telemetry: { enabled: false },
      allowLoadOutsideRoot: false,
      loadMaxFileBytes: 1_048_576,
      loadMaxFilesPerExpression: 16,
      loadMaxRecursionDepth: 4,
    };
    const configLayer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.map(Effect.succeed(config), (c) => c[key]),
      }),
    );

    let fetchCalled = false;
    const fetchImpl = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }));
    }) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get("https://example.com/artifact");
      }).pipe(Effect.provide(Layer.mergeAll(layerWith({ fetch: fetchImpl }), configLayer))),
    );

    const error = failureOf(exit);
    expect(isHttpClientError(error)).toBe(true);
    const cause = transportCause(error) as { _tag?: string; message?: string; remediation?: string };
    expect(cause._tag).toBe("HttpTrustError");
    // Parent surfaces a generic resolve message; remediation still names the env var.
    expect(cause.remediation ?? cause.message ?? "").toContain("LANDO_NETWORK_CA_CERTS");
    expect(fetchCalled).toBe(false);
  });

  test("offline policy fails before opening a connection", async () => {
    let fetchCalled = false;
    const fetchImpl = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response("nope", { status: 200 }));
    }) as unknown as typeof fetch;

    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get("https://example.com/offline");
      }).pipe(policy({ offline: true })),
      layerWith({ fetch: fetchImpl }),
    );

    expect(isHttpClientError(failureOf(exit))).toBe(true);
    expect(fetchCalled).toBe(false);
  });
});

describe("HttpClient lifecycle events", () => {
  const serveOnce = (payload: Uint8Array) =>
    ((_input: unknown) =>
      Promise.resolve(new Response(new Uint8Array(payload), { status: 200 }))) as unknown as typeof fetch;

  test("publishes redacted pre/post-http-call events with scheme+host origin", async () => {
    const secret = "SECRET-abc123";
    const url = `https://user:${secret}@evt.test/r?token=${secret}`;
    const cap = captureEvents();
    // Body drain completes observeResponse so post-http-call fires.
    await Effect.runPromise(
      getCollect(url, { callerId: `caller-${secret}`, redactionTokens: [secret] }).pipe(
        Effect.provide(layerWith({ fetch: serveOnce(new Uint8Array([1])) }).pipe(Layer.provide(cap.layer))),
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

  test("stamps onBehalfOf on events when provided via RequestPolicy", async () => {
    const cap = captureEvents();
    await Effect.runPromise(
      getCollect("https://evt.test/r", { onBehalfOf: "downloader" }).pipe(
        Effect.provide(layerWith({ fetch: serveOnce(new Uint8Array([1])) }).pipe(Layer.provide(cap.layer))),
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
      getCollect("https://evt.test/body-fail").pipe(
        Effect.provide(layerWith({ fetch: failBodyFetch }).pipe(Layer.provide(cap.layer))),
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
    expect(posts[0]?.failureDetail).toMatch(/stream read failed|Decode error/);
    expect(posts[0]?.failureDetail).not.toContain("SECRET");
  });

  test("post-http-call reports failure when Effect.timeout fires before headers", async () => {
    const cap = captureEvents();
    const hangingFetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      getCollect("https://evt.test/connect-timeout").pipe(
        Effect.timeout(Duration.millis(10)),
        Effect.provide(layerWith({ fetch: hangingFetch }).pipe(Layer.provide(cap.layer))),
      ),
    );

    const error = failureOf(exit) as { readonly _tag?: string };
    expect(error._tag).toBe("TimeoutError");
    const post = cap.events().find((e) => e._tag === "post-http-call") as
      | { readonly outcome?: string; readonly failureDetail?: string; readonly status?: number }
      | undefined;
    expect(post?.outcome).toBe("failure");
    expect(post?.status).toBeUndefined();
  });

  test("post-http-call success is emitted after the body stream completes", async () => {
    const cap = captureEvents();
    await Effect.runPromise(
      getCollect("https://evt.test/ok").pipe(
        Effect.provide(layerWith({ fetch: serveOnce(new Uint8Array([9])) }).pipe(Layer.provide(cap.layer))),
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
      Effect.gen(function* () {
        const fiber = yield* getCollect("https://evt.test/interrupted").pipe(Effect.forkChild);
        yield* Effect.sleep(Duration.millis(10));
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layerWith({ fetch: hangingBodyFetch }).pipe(Layer.provide(cap.layer)))),
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

  test("post-http-call reports a success outcome for non-2xx status without leaking the URL", async () => {
    const secret = "FAILSECRET-xyz";
    const url = `https://user:${secret}@evt.test/missing?token=${secret}`;
    const cap = captureEvents();
    const failFetch = (() =>
      Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch;
    await Effect.runPromise(
      getCollect(url, { redactionTokens: [secret] }).pipe(
        Effect.provide(layerWith({ fetch: failFetch }).pipe(Layer.provide(cap.layer))),
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

  test("request failures keep secrets out of error serialization", async () => {
    const secret = "ERRSECRET-abc";
    const url = `https://user:${secret}@evt.test/missing?token=${secret}`;
    const failFetch = (() => Promise.reject(new Error(""))) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get(url);
      }).pipe(policy({ redactionTokens: [secret] }), Effect.provide(layerWith({ fetch: failFetch }))),
    );

    const error = failureOf(exit);
    expect(isHttpClientError(error)).toBe(true);
    // Effect request inspect/JSON redacts userinfo; query values become [redacted].
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe("HttpClient egress span redaction", () => {
  test("records HttpClient.request with redacted url.full attributes", async () => {
    const secret = "SPANSECRET-xyz";
    const url = `https://user:${secret}@span.test/path?token=${secret}`;
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const serve = (() => Promise.resolve(new Response("ok", { status: 200 }))) as unknown as typeof fetch;

    await Effect.runPromise(
      getCollect(url, { redactionTokens: [secret] }).pipe(
        Effect.provide(layerWith({ fetch: serve })),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );

    const egress = spans.find((span) => span.name === "HttpClient.request");
    expect(egress).toBeDefined();
    expect(egress?.attributes.get("http.request.method")).toBe("GET");
    const full = String(egress?.attributes.get("url.full") ?? "");
    expect(full).toContain("https://span.test/path");
    expect(full).not.toContain(secret);
    expect(full).toContain("[redacted]");
    const rawUrlSpans = spans.filter(
      (span) =>
        span.name !== "HttpClient.request" && String(span.attributes.get("url.full") ?? "").includes(secret),
    );
    expect(rawUrlSpans).toHaveLength(0);
  });
});

describe("HttpClient Bun 1.4 fetch failures", () => {
  test("maps TypeError network failures to HttpClientError", async () => {
    const failFetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get("https://evt.test/down");
      }).pipe(Effect.provide(layerWith({ fetch: failFetch }))),
    );

    const error = failureOf(exit);
    expect(isHttpClientError(error)).toBe(true);
  });

  test("aborts the in-flight fetch when the scoped request scope closes", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              /* keep the body open until the scope closes */
            },
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const scoped = HttpClient.withScope(client);
          return yield* scoped.get("https://evt.test/abort-on-close");
        }).pipe(Effect.provide(layerWith({ fetch: fetchImpl }))),
      ),
    );

    expect(signal?.aborted).toBe(true);
  });

  test("execute carries method and headers for non-GET verbs", async () => {
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
      const chunks = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.execute(
            HttpClientRequest.put(server.url.href, {
              headers: { "x-token": "test" },
            }),
          );
          return yield* Stream.runCollect(response.stream);
        }).pipe(Effect.provide(layer)),
      );
      expect(seen).toEqual([{ method: "PUT", token: "test" }]);
      expect(Array.from(chunks).flatMap((chunk) => [...chunk])).toEqual([0, 1, 254, 255]);
    } finally {
      server.stop(true);
    }
  });
});
