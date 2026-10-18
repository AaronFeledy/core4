import { expect, spyOn, test } from "bun:test";
import { HttpTrustError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Layer, Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import { layerWith } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";

test.each([false, true])(
  "loopback ignores closed ambient proxies with resolved trust=%s",
  async (resolved) => {
    // Given closed ambient proxies and an accessible loopback server.
    const keys = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("loopback-ok") });
    for (const key of keys) process.env[key] = key.toLowerCase() === "no_proxy" ? "" : "http://127.0.0.1:1";
    try {
      const request = Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(server.url.href);
        return yield* response.text;
      });
      // When the Effect layer uses its real session fetch.
      const result = await Effect.runPromise(
        (resolved
          ? request.pipe(
              Effect.provideService(NetworkTrust, {
                proxy: { http: "http://127.0.0.1:1", noProxy: [] },
                caPems: [],
                trustHost: true,
              }),
            )
          : request
        ).pipe(Effect.provide(layerWith())),
      );
      // Then explicit proxy:false reaches Bun rather than consulting ambient proxies.
      expect(result).toBe("loopback-ok");
    } finally {
      server.stop(true);
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  },
);

test("resolved empty proxy plan suppresses ambient proxy selection for remote URLs", async () => {
  // Given a resolved plan with no proxy and an injected fetch recorder.
  let captured: BunFetchRequestInit | undefined;
  const fetchImpl: typeof fetch = Object.assign(
    async (_input: string | URL | Request, init?: BunFetchRequestInit) => {
      captured = init;
      return new Response(null, { status: 204 });
    },
    { preconnect: fetch.preconnect },
  );
  // When requesting a non-loopback URL through the layer.
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* client.get("https://remote.test/");
    }).pipe(
      Effect.provideService(NetworkTrust, { proxy: { noProxy: [] }, caPems: [], trustHost: true }),
      Effect.provide(layerWith({ fetch: fetchImpl })),
    ),
  );
  // Then Bun cannot reintroduce any ambient proxy.
  expect(captured?.proxy).toBe(false);
});

test("proxy CONNECT refusal becomes a tagged trust failure without exposing headers", async () => {
  // Given a real proxy refusing every CONNECT with a secret-bearing header.
  const secret = "proxy-private-challenge";
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 407, headers: { "proxy-authenticate": secret } }),
  });
  try {
    // When a remote HTTPS request uses the resolved proxy through Bun's session.
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get("https://remote.invalid/");
      }).pipe(
        Effect.provideService(NetworkTrust, {
          proxy: { https: proxy.url.href, noProxy: [] },
          caPems: [],
          trustHost: true,
        }),
        Effect.provide(layerWith()),
      ),
    );
    // Then transport cause preserves the classified refusal and safe remediation.
    expect(Exit.isFailure(result)).toBe(true);
    if (!Exit.isFailure(result)) throw new Error("expected tunnel refusal");
    const failure = Cause.findErrorOption(result.cause);
    if (failure._tag !== "Some" || !HttpClientError.isHttpClientError(failure.value))
      throw new Error("expected HTTP failure");
    const reason = failure.value.reason;
    if (reason._tag !== "TransportError" || !(reason.cause instanceof HttpTrustError))
      throw new Error("expected trust cause");
    expect(reason.cause.kind).toBe("proxy-tunnel-refused");
    expect(reason.cause.urlOrigin).toBe("https://remote.invalid");
    expect(reason.cause.remediation).toContain("407");
    expect(reason.cause.message).not.toContain(secret);
    expect(reason.cause.remediation).not.toContain(secret);
  } finally {
    proxy.stop(true);
  }
});

test("closes exactly one session for each acquired layer scope", async () => {
  // Given two independently acquired layer instances and a restored-on-exit native close spy.
  const close = spyOn(Bun.FetchSession.prototype, "close");
  const first = await Effect.runPromise(Scope.make());
  const second = await Effect.runPromise(Scope.make());
  try {
    await Effect.runPromise(Layer.buildWithScope(layerWith(), first));
    await Effect.runPromise(Layer.buildWithScope(layerWith(), second));
    expect(close).toHaveBeenCalledTimes(0);
    // When their owning scopes close independently.
    await Effect.runPromise(Scope.close(first, Exit.void));
    expect(close).toHaveBeenCalledTimes(1);
    await Effect.runPromise(Scope.close(second, Exit.void));
    // Then each pool closes once, not globally or per request.
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.contexts[0]).not.toBe(close.mock.contexts[1]);
  } finally {
    await Effect.runPromise(Scope.close(first, Exit.void));
    await Effect.runPromise(Scope.close(second, Exit.void));
    close.mockRestore();
  }
});
