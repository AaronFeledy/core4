import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Cause, Duration, Effect, Exit, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { type ClientOptions, layerWith } from "../src/live.ts";
import { NetworkTrust } from "../src/network-trust.ts";

let directory: string;
let cert: string;
let key: string;
let chainCert: string;
let chainKey: string;
let hostOnlyCert: string;
let hostOnlyKey: string;

const openssl = async (...args: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn(["openssl", ...args], { cwd: directory, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
};

const selfSigned = (name: string, san: string) =>
  openssl(
    ..."req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost".split(" "),
    "-addext",
    `subjectAltName=${san}`,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.pem`,
  );

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "lando-http-tls-"));
  await selfSigned("cert", "DNS:localhost,IP:127.0.0.1");
  await selfSigned("host-only", "DNS:localhost");
  // A leaf issued by a private root, served with that root in the chain.
  await openssl(
    ..."req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Private-Root".split(" "),
    "-keyout",
    "root.key",
    "-out",
    "root.pem",
  );
  await openssl(
    ..."req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout leaf.key -out leaf.csr".split(" "),
  );
  await writeFile(join(directory, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  await openssl(
    ..."x509 -req -in leaf.csr -CA root.pem -CAkey root.key -CAcreateserial -days 2 -extfile leaf.ext -out leaf.pem".split(
      " ",
    ),
  );
  const read = (name: string) => readFile(join(directory, name), "utf8");
  cert = await read("cert.pem");
  key = await read("cert.key");
  hostOnlyCert = await read("host-only.pem");
  hostOnlyKey = await read("host-only.key");
  chainKey = await read("leaf.key");
  chainCert = `${await read("leaf.pem")}${await read("root.pem")}`;
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

/** The transport cause of a failed GET through the live client. */
const transportCause = async (
  url: string,
  options: { readonly trust?: { readonly caPems: ReadonlyArray<string> }; readonly client?: ClientOptions },
) => {
  const program = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url);
  }).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.provide(layerWith({ systemCaPems: () => [], ...options.client })),
    Effect.provideService(NetworkTrust, {
      proxy: { noProxy: [] },
      caPems: options.trust?.caPems ?? [],
      trustHost: false,
    }),
  );
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) throw new Error("expected the request to fail");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "None") throw new Error(`expected a typed failure: ${Cause.pretty(exit.cause)}`);
  const error = failure.value;
  if (error._tag !== "HttpClientError" || error.reason._tag !== "TransportError")
    throw new Error(`expected a transport error, got ${String(error)}`);
  return error.reason.cause;
};

test("classifies an untrusted private-root chain as missing-custom-ca with the verification code", async () => {
  // Given: a leaf served with its private root, which the client does not trust.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: chainCert, key: chainKey },
    fetch: () => new Response("ok"),
  });
  try {
    // When / Then
    expect(await transportCause(server.url.href, {})).toMatchObject({
      _tag: "HttpTrustError",
      kind: "missing-custom-ca",
      message: expect.stringContaining("(SELF_SIGNED_CERT_IN_CHAIN)"),
    });
  } finally {
    server.stop(true);
  }
});

test("classifies a trusted certificate for another host as certificate-invalid", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: hostOnlyCert, key: hostOnlyKey },
    fetch: () => new Response("ok"),
  });
  try {
    const cause = await transportCause(server.url.href, { trust: { caPems: [hostOnlyCert] } });
    expect(cause).toMatchObject({
      _tag: "HttpTrustError",
      kind: "certificate-invalid",
      remediation: expect.stringContaining("adding a CA does not fix it"),
    });
  } finally {
    server.stop(true);
  }
});

test("classifies an expired certificate (CERT_HAS_EXPIRED) as certificate-invalid without Bun's hint", async () => {
  // Bun reports an expired leaf as a TypeError carrying the verification code and a developer hint.
  const expired: typeof fetch = Object.assign(
    async () => {
      throw Object.assign(
        new TypeError(
          "certificate has expired For more information, pass `verbose: true` in the second argument to fetch()",
        ),
        { code: "CERT_HAS_EXPIRED" },
      );
    },
    { preconnect: fetch.preconnect },
  );
  expect(await transportCause("https://expired.test/", { client: { fetch: expired } })).toMatchObject({
    _tag: "HttpTrustError",
    kind: "certificate-invalid",
    message:
      "TLS trust verification failed for https://expired.test: certificate has expired (CERT_HAS_EXPIRED)",
  });
});

test("a non-TLS listener (EPROTO) and a dropped handshake (ECONNRESET) stay network failures", async () => {
  const plain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("plain") });
  const drop = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (socket) => socket.terminate(),
      data: () => undefined,
    },
  });
  try {
    expect(await transportCause(`https://127.0.0.1:${plain.port}/`, {})).toMatchObject({ code: "EPROTO" });
    expect(await transportCause(`https://127.0.0.1:${drop.port}/`, {})).toMatchObject({ code: "ECONNRESET" });
  } finally {
    plain.stop(true);
    drop.stop(true);
  }
});
