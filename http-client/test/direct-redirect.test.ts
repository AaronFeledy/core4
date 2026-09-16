import { expect, test } from "bun:test";
import { HttpRequestError } from "@lando/sdk/errors";
import { Effect, Exit } from "effect";
import { makeHttpClientLive } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";
import { HttpClient } from "../src/service.ts";

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
        calls.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      },
      { preconnect: fetch.preconnect },
    );
    try {
      // When the real direct adapter encounters the redirect.
      const result = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.flatMap(HttpClient, (client) =>
            client.stream({
              url: origin.url.href,
              redirect,
              method: "POST",
              headers: [
                { name: "Authorization", value: "Bearer secret" },
                { name: "Cookie", value: "session=secret" },
                { name: "Proxy-Authorization", value: "Basic secret" },
                { name: "Host", value: "local.test" },
                { name: "x-safe", value: "keep" },
              ],
            }),
          ).pipe(
            Effect.provide(makeHttpClientLive(fetchImpl, () => ["host-ca"])),
            Effect.provideService(NetworkTrust, {
              proxy: { https: "http://proxy.test:3128", noProxy: [] },
              caPems: ["custom-ca"],
              trustHost: true,
            }),
          ),
        ),
      );
      // Then follow switches transport, manual returns the redirect, error fails closed.
      switch (redirect) {
        case "follow": {
          expect(Exit.isSuccess(result) && result.value.status).toBe(204);
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe("https://remote.test/final");
          expect(calls[0]?.init?.proxy).toBe("http://proxy.test:3128");
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

test("a remote redirect cannot escape the proxy into a local endpoint", async () => {
  // Given a proxied response pointing back to a local origin.
  let localCalls = 0;
  const origin = Bun.serve({
    hostname: "127.0.0.1",
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
        : new Response(null, { status: 204 });
    },
    { preconnect: fetch.preconnect },
  );
  try {
    // When following the remote redirect.
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) => client.stream({ url: "http://remote.test/" })).pipe(
          Effect.provide(makeHttpClientLive(fetchImpl)),
          Effect.provideService(NetworkTrust, {
            proxy: { http: "http://proxy.test:3128", noProxy: [] },
            caPems: [],
            trustHost: true,
          }),
        ),
      ),
    );
    // Then both hops retain the proxy and the local server receives no request.
    expect(response.status).toBe(204);
    expect(calls).toEqual([
      { url: "http://remote.test/", proxy: "http://proxy.test:3128" },
      { url: origin.url.href, proxy: "http://proxy.test:3128" },
    ]);
    expect(localCalls).toBe(0);
  } finally {
    origin.stop(true);
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
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(HttpClient, (client) => client.stream({ url: origin.url.href })).pipe(
          Effect.provide(makeHttpClientLive()),
          Effect.flip,
        ),
      ),
    );
    // Then redirect loops cannot hold a scanner scope indefinitely.
    expect(error).toBeInstanceOf(HttpRequestError);
    expect(calls).toBe(21);
  } finally {
    origin.stop(true);
  }
});
