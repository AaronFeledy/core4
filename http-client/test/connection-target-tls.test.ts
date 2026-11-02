import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { RequestPolicy, layerWith } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";

let directory: string;
let cert: string;
let key: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "http-pinned-tls-"));
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=pinned.invalid",
      "-addext",
      "subjectAltName=DNS:pinned.invalid",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
  [cert, key] = await Promise.all([
    readFile(join(directory, "cert.pem"), "utf8"),
    readFile(join(directory, "key.pem"), "utf8"),
  ]);
});
afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

test.each(["trusted", "wrong-identity", "untrusted", "redirect"] as const)(
  "pinned DNS-only TLS %s preserves verification and single-hop authority",
  async (kind) => {
    // Given a DNS-only certificate and no DNS or proxy route to the fixture.
    const requests: string[] = [];
    let proxyCalls = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        proxyCalls += 1;
        return new Response(null, { status: 502 });
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      fetch: (request) => {
        requests.push(request.headers.get("host") ?? "");
        return kind === "redirect"
          ? new Response(null, { status: 302, headers: { location: `${proxy.url}private` } })
          : new Response("trusted ingress");
      },
    });
    const origin = `https://${kind === "wrong-identity" ? "other.invalid" : "pinned.invalid"}:${server.port}`;
    const policy = { connectionTarget: { address: "127.0.0.1", origin }, redirect: "follow" as const };
    try {
      // When the production HTTP service pins only the socket destination.
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`${origin}/`);
          return { status: response.status, body: yield* response.text };
        }).pipe(
          Effect.scoped,
          Effect.timeout("2 seconds"),
          Effect.provide(layerWith({ env: {} })),
          Effect.provideService(RequestPolicy, policy),
          Effect.provideService(NetworkTrust, {
            proxy: { https: proxy.url.href, noProxy: [] },
            caPems: kind === "untrusted" ? [] : [cert],
            trustHost: false,
          }),
        ),
      );
      // Then trust and identity failures fail closed and redirects never leave the pinned hop.
      const succeeds = kind === "trusted" || kind === "redirect";
      expect(Exit.isSuccess(result)).toBe(succeeds);
      if (Exit.isSuccess(result)) expect(result.value.status).toBe(kind === "redirect" ? 302 : 200);
      expect(requests).toEqual(succeeds ? [`pinned.invalid:${server.port}`] : []);
      expect(proxyCalls).toBe(0);
    } finally {
      await Promise.all([server.stop(true), proxy.stop(true)]);
    }
  },
);
