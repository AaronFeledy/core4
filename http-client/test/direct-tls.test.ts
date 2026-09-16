import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { makeHttpClientLive } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";
import { HttpClient } from "../src/service.ts";

let directory: string;
let cert: string;
let key: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "lando-http-tls-"));
  const process = Bun.spawn(
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
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
  [cert, key] = await Promise.all([
    readFile(join(directory, "cert.pem"), "utf8"),
    readFile(join(directory, "key.pem"), "utf8"),
  ]);
});
afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

test.each(["custom", "merged", "empty", "default"] as const)(
  "preserves %s CA trust for direct HTTPS",
  async (mode) => {
    // Given a self-signed local HTTPS endpoint and explicit trust inputs.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      fetch: () => new Response(null, { status: 204 }),
    });
    const trust = {
      proxy: { https: "http://unreachable.invalid:3128", noProxy: [] },
      caPems: mode === "custom" || mode === "merged" ? [cert] : [],
      trustHost: mode === "merged" || mode === "default",
    };
    try {
      // When TLS connects through the direct transport, keeping verification enabled.
      const result = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.flatMap(HttpClient, (client) =>
            client.stream({ url: server.url.href, timeoutMs: 1000 }),
          ).pipe(
            Effect.provide(makeHttpClientLive(fetch, () => (mode === "merged" ? [cert] : []))),
            Effect.provideService(NetworkTrust, trust),
          ),
        ),
      );
      // Then only explicitly trusted roots succeed; an empty CA list fails closed.
      expect(Exit.isSuccess(result)).toBe(mode === "custom" || mode === "merged");
    } finally {
      server.stop(true);
    }
  },
);
