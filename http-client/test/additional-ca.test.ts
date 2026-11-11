import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { layerWith } from "../src/live.ts";
import { LocalCaTrustSource, isLocalProbeHost } from "../src/local-ca-trust.ts";
import { NetworkTrust } from "../src/network-trust.ts";

let directory: string;
let rootPem: string;
let leafCert: string;
let leafKey: string;

const openssl = async (...args: readonly string[]): Promise<void> => {
  const child = Bun.spawn(["openssl", ...args], { cwd: directory, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
};

const tlsCa = (init: RequestInit | undefined): readonly string[] | undefined => {
  if (init === undefined || !("tls" in init)) return undefined;
  const tls = init.tls;
  if (typeof tls !== "object" || tls === null || !("ca" in tls)) return undefined;
  const ca = tls.ca;
  if (!Array.isArray(ca)) return undefined;
  return ca.filter((item): item is string => typeof item === "string");
};

const proxyOf = (init: RequestInit | undefined): unknown =>
  init !== undefined && "proxy" in init ? init.proxy : undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "lando-local-ca-"));
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Lando-Test-Root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    "root.key",
    "-out",
    "root.pem",
  );
  await openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
  );
  await Bun.write(join(directory, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  await openssl(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "root.pem",
    "-CAkey",
    "root.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    "leaf.ext",
    "-out",
    "leaf.pem",
  );
  rootPem = await readFile(join(directory, "root.pem"), "utf8");
  leafCert = await readFile(join(directory, "leaf.pem"), "utf8");
  leafKey = await readFile(join(directory, "leaf.key"), "utf8");
});

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

const source = LocalCaTrustSource.of({
  prepare: () =>
    Effect.succeed({
      pem: rootPem,
      isLocalHost: (hostname: string) => isLocalProbeHost(hostname, "lndo.site"),
    }),
  trusted: Effect.succeed(false),
});

const recordedFetch = (seen: Array<RequestInit | undefined>): typeof fetch => {
  const impl: typeof fetch = (_input, init) => {
    seen.push(init);
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  return impl;
};

const get = (url: string, seen: Array<RequestInit | undefined>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return yield* http.get(url);
    }),
  ).pipe(
    Effect.provide(layerWith({ fetch: recordedFetch(seen), systemCaPems: () => ["HOST-ROOT"] })),
    Effect.provide(Layer.succeed(LocalCaTrustSource, source)),
  );

test("a local HTTPS probe trusts the development root and does not set a proxy", async () => {
  const seen: Array<RequestInit | undefined> = [];
  await Effect.runPromise(get("https://web.example.lndo.site/", seen));
  expect(proxyOf(seen[0])).toBeUndefined();
  expect(tlsCa(seen[0])).toEqual(["HOST-ROOT", rootPem]);
});

test("a public HTTPS request ignores the development root", async () => {
  const seen: Array<RequestInit | undefined> = [];
  await Effect.runPromise(get("https://example.com/", seen));
  expect(tlsCa(seen[0])).toBeUndefined();
});

test("an injected proxy survives a local probe and a trustHost false list keeps the development root", async () => {
  const seen: Array<RequestInit | undefined> = [];
  await Effect.runPromise(
    get("https://web.example.lndo.site/", seen).pipe(
      Effect.provideService(NetworkTrust, {
        proxy: { https: "http://proxy.example:8080", noProxy: ["example.com"] },
        caPems: ["CORP-CA"],
        trustHost: false,
      }),
    ),
  );
  expect(proxyOf(seen[0])).toEqual({ url: "http://proxy.example:8080", respectNoProxy: false });
  expect(tlsCa(seen[0])).toEqual(["CORP-CA", rootPem]);
});

test("loopback TLS verifies with the development root and fails without the source", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: leafCert, key: leafKey },
    fetch: () => new Response("private-ok"),
  });
  const url = `https://127.0.0.1:${server.port}/`;
  const read = Effect.scoped(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(url);
      return yield* response.text;
    }),
  ).pipe(Effect.provide(layerWith({ systemCaPems: () => [] })));
  try {
    const trusted = await Effect.runPromise(
      read.pipe(Effect.provide(Layer.succeed(LocalCaTrustSource, source))),
    );
    expect(trusted).toBe("private-ok");
    const untrusted = await Effect.runPromiseExit(read);
    expect(untrusted._tag).toBe("Failure");
  } finally {
    server.stop(true);
  }
});
