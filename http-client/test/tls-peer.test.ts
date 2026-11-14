import { afterAll, beforeAll, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer } from "node:tls";
import { observeTlsPeer } from "@lando/http-client/tls-peer";
import { Cause, Effect, Exit, Fiber } from "effect";

let directory: string;
let leaf: string;
let key: string;
let otherRoot: string;
let otherKey: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tls-peer-"));
  const pairs = await Promise.all(
    ["pinned.invalid", "other.invalid"].map(async (hostname) => {
      const certPath = join(directory, `${hostname}.pem`);
      const keyPath = join(directory, `${hostname}.key`);
      const child = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-days",
          "2",
          "-subj",
          `/CN=${hostname}`,
          "-addext",
          `subjectAltName=DNS:${hostname}`,
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`TLS fixture generation failed: ${stderr}`);
      return { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8") };
    }),
  );
  const [first, second] = pairs;
  if (first === undefined || second === undefined) throw new Error("Missing TLS fixtures");
  leaf = first.cert;
  key = first.key;
  otherRoot = second.cert;
  otherKey = second.key;
});
afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

const withPeer = async (
  tls: boolean,
  run: (peer: {
    readonly port: number;
    readonly connected: Promise<Socket>;
    readonly closed: Promise<void>;
    readonly names: string[];
    readonly applicationBytes: () => number;
  }) => Promise<void>,
) => {
  const connected = Promise.withResolvers<Socket>();
  const closed = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const names: string[] = [];
  let bytes = 0;
  await using server = tls
    ? createTlsServer(
        {
          cert: otherRoot,
          key: otherKey,
          SNICallback: (name, done) => {
            names.push(name);
            done(null, createSecureContext({ cert: leaf, key }));
          },
        },
        (socket) => {
          socket.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
          });
        },
      )
    : createServer((socket) => {
        socket.resume();
      });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      closed.resolve();
    });
    connected.resolve(socket);
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing TCP port");
  try {
    await run({
      port: address.port,
      connected: connected.promise,
      closed: closed.promise,
      names,
      applicationBytes: () => bytes,
    });
  } finally {
    for (const socket of sockets) socket.destroy();
  }
};

test("observes the exact pinned SNI leaf without DNS or application data and closes immediately", async () => {
  await withPeer(true, async (peer) => {
    const observed = await Effect.runPromise(
      observeTlsPeer({ hostname: "pinned.invalid", port: peer.port, address: "127.0.0.1", caPems: [leaf] }),
    );
    await peer.closed;
    expect(observed).toBe(new X509Certificate(leaf).toString());
    expect(peer.names).toEqual(["pinned.invalid"]);
    expect(peer.applicationBytes()).toBe(0);
  });
});

test.each(["wrong-root", "wrong-name"] as const)("rejects %s with sanitized typed failure", async (kind) => {
  await withPeer(true, async (peer) => {
    const result = await Effect.runPromise(
      observeTlsPeer({
        hostname: kind === "wrong-name" ? "other.invalid" : "pinned.invalid",
        port: peer.port,
        address: "127.0.0.1",
        caPems: [kind === "wrong-root" ? otherRoot : leaf],
      }).pipe(Effect.flip),
    );
    expect(result._tag).toBe("TlsPeerError");
    expect(result.reason).toBe("handshake");
    const diagnostic = JSON.stringify(result);
    expect(diagnostic).not.toContain("BEGIN CERTIFICATE");
    expect(diagnostic).not.toContain("PRIVATE KEY");
    expect(diagnostic).not.toContain("subjectaltname");
    await peer.closed;
  });
});

test.each([
  { hostname: "*.invalid" },
  { hostname: "https://pinned.invalid" },
  { hostname: "-----BEGIN CERTIFICATE-----secret" },
  { address: "pinned.invalid" },
  { address: "127.0.0.1/path" },
  { port: 0 },
  { port: 65536 },
  { port: 1.5 },
  { caPems: [] },
  { caPems: [""] },
  { caPems: ["-----BEGIN CERTIFICATE-----secret"] },
])("rejects invalid target or trust before opening a connection: %j", async (override) => {
  const error = await Effect.runPromise(
    observeTlsPeer({
      hostname: "pinned.invalid",
      address: "127.0.0.1",
      port: 1,
      caPems: [leaf],
      ...override,
    }).pipe(Effect.flip),
  );
  expect(error._tag).toBe("TlsPeerError");
  expect(error.reason).toBe(override.caPems === undefined ? "invalid-target" : "invalid-trust");
  expect(JSON.stringify(error)).not.toContain("secret");
});

test("bounds a silent TCP peer to one two-second attempt and closes its socket", async () => {
  await withPeer(false, async (peer) => {
    const error = await Effect.runPromise(
      observeTlsPeer({
        hostname: "pinned.invalid",
        address: "127.0.0.1",
        port: peer.port,
        caPems: [leaf],
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("timeout");
    await peer.closed;
  });
}, 3000);

test("interruption destroys an in-flight handshake", async () => {
  await withPeer(false, async (peer) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          observeTlsPeer({
            hostname: "pinned.invalid",
            address: "127.0.0.1",
            port: peer.port,
            caPems: [leaf],
          }),
        );
        yield* Effect.promise(() => peer.connected);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    await peer.closed;
  });
}, 1500);
