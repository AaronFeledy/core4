import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { RequestPolicy, layer, layerWith } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";

test.each(["follow", "manual", "error"] as const)(
  "handles %s redirects with endpoint trust per hop",
  async (redirect) => {
    // Given a local endpoint redirecting to a remote origin with sensitive headers.
    const calls: { readonly url: string; readonly init: BunFetchRequestInit | undefined }[] = [];
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("discard this body", {
          status: 302,
          headers: { location: "https://remote.test/final" },
        }),
    });
    const fetchImpl: typeof fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
        if (String(url) === origin.url.href) return fetch(url, init);
        calls.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      },
      { preconnect: fetch.preconnect },
    );
    try {
      // When the real loopback fetch encounters the redirect.
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.execute(
            HttpClientRequest.post(origin.url.href, {
              headers: {
                Authorization: "Bearer secret",
                Cookie: "session=secret",
                "Proxy-Authorization": "Basic secret",
                Host: "local.test",
                "x-safe": "keep",
              },
            }),
          );
        }).pipe(
          Effect.provideService(RequestPolicy, { redirect }),
          Effect.provide(layerWith({ fetch: fetchImpl, systemCaPems: () => ["host-ca"] })),
          Effect.provideService(NetworkTrust, {
            proxy: { https: "http://proxy.test:3128", noProxy: [] },
            caPems: ["custom-ca"],
            trustHost: true,
          }),
        ),
      );
      // Then follow selects the next hop's proxy, manual returns the redirect, error fails closed.
      switch (redirect) {
        case "follow": {
          expect(Exit.isSuccess(result) && result.value.status).toBe(204);
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe("https://remote.test/final");
          expect(calls[0]?.init?.proxy).toEqual({ url: "http://proxy.test:3128", respectNoProxy: false });
          expect(calls[0]?.init?.tls).toEqual({ ca: ["host-ca", "custom-ca"] });
          expect(calls[0]?.init?.method).toBe("GET");
          const headers = new Headers(calls[0]?.init?.headers);
          for (const name of ["authorization", "cookie", "proxy-authorization", "host"])
            expect(headers.has(name)).toBe(false);
          expect(headers.get("x-safe")).toBe("keep");
          break;
        }
        case "manual":
          expect(Exit.isSuccess(result) && result.value.status).toBe(302);
          expect(calls).toHaveLength(0);
          break;
        case "error":
          expect(Exit.isFailure(result)).toBe(true);
          expect(calls).toHaveLength(0);
          break;
        default: {
          const exhaustive: never = redirect;
          throw exhaustive;
        }
      }
    } finally {
      origin.stop(true);
    }
  },
);

test.each(["127.0.0.1", "127.0.0.2", "::1"])(
  "rejects a remote redirect to %s before connecting locally",
  async (hostname) => {
    // Given a proxied response pointing back to a local origin.
    let localCalls = 0;
    const origin = Bun.serve({
      hostname,
      port: 0,
      fetch: () => {
        localCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    const calls: { readonly url: string; readonly proxy: BunFetchRequestInit["proxy"] }[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
        calls.push({ url: String(url), proxy: init?.proxy });
        return String(url) === "http://remote.test/"
          ? new Response(null, { status: 307, headers: { location: origin.url.href } })
          : fetch(url, init);
      },
      { preconnect: fetch.preconnect },
    );
    try {
      // When following the remote redirect.
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.get("http://remote.test/");
        }).pipe(
          Effect.provide(layerWith({ fetch: fetchImpl })),
          Effect.provideService(NetworkTrust, {
            proxy: { http: "http://proxy.test:3128", noProxy: [] },
            caPems: [],
            trustHost: true,
          }),
        ),
      );
      // Then only the remote hop uses the plan's proxy, and no local connection occurs.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("remote redirect to loopback forbidden");
      expect(calls).toEqual([
        { url: "http://remote.test/", proxy: { url: "http://proxy.test:3128", respectNoProxy: false } },
      ]);
      expect(localCalls).toBe(0);
    } finally {
      origin.stop(true);
    }
  },
);

test("a loopback redirect to another loopback origin stays off the proxy", async () => {
  let targetCalls = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      targetCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 302, headers: { location: target.url.href } }),
  });
  try {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get(origin.url.href);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(NetworkTrust, {
          proxy: { http: "http://proxy.test:3128", noProxy: [] },
          caPems: [],
          trustHost: true,
        }),
      ),
    );
    expect(response.status).toBe(204);
    expect(targetCalls).toBe(1);
  } finally {
    origin.stop(true);
    target.stop(true);
  }
});

test("bounds redirect loops with a typed failure", async () => {
  // Given an endpoint that redirects to itself.
  let calls = 0;
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "/" } });
    },
  });
  try {
    // When the redirect limit is exhausted.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.get(origin.url.href);
      }).pipe(Effect.provide(layer)),
    );
    // Then redirect loops cannot hold a scanner scope indefinitely.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toBe(21);
  } finally {
    origin.stop(true);
  }
});
