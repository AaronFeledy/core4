import { expect, test } from "bun:test";

test.each(["http://remote.invalid/status", "http://app.lndo.site/status", "local", "no-proxy"])(
  "routes %s through the real Bun transport with ambient proxy configured",
  async (target) => {
    // Given isolated local origin/proxy servers and a child with ambient proxy settings.
    let directCalls = 0;
    let proxyCalls = 0;
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        directCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        proxyCalls += 1;
        return new Response(null, { status: 203 });
      },
    });
    const direct = target === "local" || target === "no-proxy";
    const url = direct ? origin.url.href : target;
    const script = `
      import { Effect } from "effect";
      import { HttpClientLive } from "./http-client/src/live.ts";
      import { HttpClient } from "./http-client/src/service.ts";
      import { NetworkTrust } from "./http-client/src/network-trust.ts";
      const program = Effect.flatMap(HttpClient, client => client.stream({ url: ${JSON.stringify(url)} }));
      const trusted = ${JSON.stringify(target)} === "no-proxy"
        ? program.pipe(Effect.provideService(NetworkTrust, {
            proxy: { http: ${JSON.stringify(proxy.url.href)}, noProxy: ["127.0.0.1"] },
            caPems: [], trustHost: true,
          })) : program;
      const response = await Effect.runPromise(Effect.scoped(trusted.pipe(Effect.provide(HttpClientLive))));
      if (response.status !== ${direct ? 204 : 203}) process.exit(2);
    `;
    try {
      // When HttpClient opens a header-only response (no shell or external service).
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: new URL("../../", import.meta.url).pathname,
        env: {
          ...process.env,
          HTTP_PROXY: proxy.url.href,
          HTTPS_PROXY: proxy.url.href,
          http_proxy: proxy.url.href,
          https_proxy: proxy.url.href,
          NO_PROXY: "",
          no_proxy: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      // Then explicit direct routing cannot fall back to Bun's ambient proxy.
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(directCalls).toBe(direct ? 1 : 0);
      expect(proxyCalls).toBe(direct ? 0 : 1);
    } finally {
      origin.stop(true);
      proxy.stop(true);
    }
  },
);
