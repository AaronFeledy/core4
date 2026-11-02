import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Cause, Duration, Effect, Exit, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { layerWith } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";

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

test.each(["config", "env", "missing"] as const)(
  "resolves %s private CA trust from the requesting fiber",
  async (mode) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      fetch: () => new Response("private-ca-ok"),
    });
    const previous = process.env.LANDO_NETWORK_CA_CERTS;
    if (mode === "env") process.env.LANDO_NETWORK_CA_CERTS = JSON.stringify([join(directory, "cert.pem")]);
    else Reflect.deleteProperty(process.env, "LANDO_NETWORK_CA_CERTS");
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: {
        ca: { certs: mode === "config" ? [join(directory, "cert.pem")] : [], trustHost: false },
      },
    });
    const load = Effect.succeed(config);
    try {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(server.url.href);
          return yield* response.text;
        }).pipe(
          Effect.provide(layerWith({ systemCaPems: () => [] })),
          Effect.provideService(
            ConfigService,
            ConfigService.of({ load, get: (key) => Effect.map(load, (value) => value[key]) }),
          ),
        ),
      );
      if (mode === "missing") {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") {
            expect(failure.value).toMatchObject({
              _tag: "HttpClientError",
              reason: { _tag: "TransportError", cause: { _tag: "HttpTrustError" } },
            });
          }
        }
      } else {
        expect(result).toMatchObject({ _tag: "Success", value: "private-ca-ok" });
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_NETWORK_CA_CERTS");
      else process.env.LANDO_NETWORK_CA_CERTS = previous;
      server.stop(true);
    }
  },
);

test.each(["custom", "merged", "empty", "default"] as const)(
  "preserves %s CA trust for loopback HTTPS fetch",
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
      // When fetch connects with proxy:false and TLS verification enabled.
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.get(server.url.href);
        }).pipe(
          Effect.timeout(Duration.millis(1000)),
          Effect.provide(layerWith({ systemCaPems: () => (mode === "merged" ? [cert] : []) })),
          Effect.provideService(NetworkTrust, trust),
        ),
      );
      // Then only explicitly trusted roots succeed; empty/default CA lists fail closed with trust cause.
      const shouldSucceed = mode === "custom" || mode === "merged";
      expect(Exit.isSuccess(result)).toBe(shouldSucceed);
      if (!shouldSucceed) {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") {
            expect(failure.value).toMatchObject({
              _tag: "HttpClientError",
              reason: {
                _tag: "TransportError",
                cause: { _tag: "HttpTrustError", kind: "missing-custom-ca" },
              },
            });
          }
        }
      }
    } finally {
      server.stop(true);
    }
  },
);
