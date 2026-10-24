import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerWith } from "@lando/http-client";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { acquisitionStateFile, defaultIssuerFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisition, app, liveGraph, makeObserveFixture, route } from "./observe-routes-fixture.ts";

test.each(["trusted", "missing-issuer", "untrusted-issuer", "wrong-identity"] as const)(
  "observes DNS-only HTTPS ingress using the router's issuer: %s",
  async (kind) => {
    // Given real loopback ingress with a certificate that deliberately excludes IP SANs.
    const directory = await mkdtemp(join(tmpdir(), "router-observation-tls-"));
    try {
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
          "/CN=traefik.example.test",
          "-addext",
          `subjectAltName=DNS:${kind === "wrong-identity" ? "other.example.test" : "traefik.example.test"}`,
          "-keyout",
          join(directory, "key.pem"),
          "-out",
          join(directory, "cert.pem"),
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
      const [cert, key] = await Promise.all([
        readFile(join(directory, "cert.pem"), "utf8"),
        readFile(join(directory, "key.pem"), "utf8"),
      ]);
      let issuer = cert;
      if (kind === "untrusted-issuer") {
        const unrelated = Bun.spawn(
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
            "/CN=unrelated issuer",
            "-keyout",
            join(directory, "unrelated-key.pem"),
            "-out",
            join(directory, "unrelated-cert.pem"),
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        const [code, stderr] = await Promise.all([unrelated.exited, new Response(unrelated.stderr).text()]);
        if (code !== 0) throw new Error(`Unrelated issuer generation failed: ${stderr}`);
        issuer = await readFile(join(directory, "unrelated-cert.pem"), "utf8");
      }
      const hosts: string[] = [];
      const httpServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          hosts.push(request.headers.get("host") ?? "");
          return new URL(request.url).pathname === "/api/rawdata"
            ? Response.json(liveGraph())
            : new Response(null, { status: 404 });
        },
      });
      const httpsServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert, key },
        fetch: (request) => {
          hosts.push(request.headers.get("host") ?? "");
          return new Response(null, { status: 404 });
        },
      });
      try {
        const fixture = makeObserveFixture();
        if (kind !== "missing-issuer") {
          fixture.files.set(defaultIssuerFile(fixture.paths, "example.test"), issuer);
        }
        fixture.files.set(
          acquisitionStateFile(fixture.paths),
          JSON.stringify({
            ...acquisition,
            httpPort: httpServer.port,
            httpsPort: httpsServer.port,
          }),
        );
        const { probeForward: _probe, httpClient: _client, ...dependencies } = fixture.dependencies;
        // When the router uses its actual HTTP layer, not a successful probe double.
        const evidence = await Effect.runPromise(
          Effect.gen(function* () {
            const httpClient = yield* HttpClient.HttpClient;
            return yield* makeTraefikRouterService({ ...dependencies, httpClient }).observeRoutes(app, [
              route,
            ]);
          }).pipe(Effect.provide(layerWith({ env: {} }))),
        );
        // Then both schemes are genuinely observed, without mutating router lifecycle state.
        expect(evidence.observation.status).toBe(kind === "trusted" ? "present" : "unknown");
        expect(hosts).toEqual(
          kind === "trusted"
            ? [
                `traefik.example.test:${httpServer.port}`,
                `traefik.example.test:${httpsServer.port}`,
                `traefik.example.test:${httpServer.port}`,
              ]
            : [`traefik.example.test:${httpServer.port}`],
        );
        expect(fixture.mutations).toEqual([]);
      } finally {
        await Promise.all([httpServer.stop(true), httpsServer.stop(true)]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
