import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { liveTraefikFixture, liveTraefikLayers } from "./live-traefik-fixture.ts";
import { routeOwner } from "./route-owner-fixture.ts";
import pem from "./router-certificate-fixtures.json";

const socket = resolveLiveProviderSocket();
const e2e = process.env.LANDO_GUIDE_E2E === "1";

interface PeerMaterial {
  readonly certificate: string;
  readonly privateKey: string;
}

const selfSignedPeer = async (directory: string, commonName: string): Promise<PeerMaterial> => {
  const key = join(directory, `${commonName}-key.pem`);
  const cert = join(directory, `${commonName}-cert.pem`);
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
      `/CN=${commonName}`,
      "-addext",
      `subjectAltName=DNS:${commonName}`,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Backend TLS fixture generation failed: ${stderr}`);
  const [certificate, privateKey] = await Promise.all([readFile(cert, "utf8"), readFile(key, "utf8")]);
  return { certificate, privateKey };
};

const requestThroughRouter = async (input: {
  readonly hostname: string;
  readonly port: number;
  readonly caPath: string;
}) => {
  const child = Bun.spawn(
    [
      "curl",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "--resolve",
      `${input.hostname}:${input.port}:127.0.0.1`,
      "--cacert",
      input.caPath,
      "--write-out",
      "\n%{http_code}",
      `https://${input.hostname}:${input.port}/`,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  const statusAt = stdout.lastIndexOf("\n");
  return { status: Number(stdout.slice(statusAt + 1)), body: stdout.slice(0, statusAt) };
};

test.skipIf(socket === undefined && !e2e)(
  "verifies managed backend certificates through real Traefik and rejects untrusted or mismatched peers",
  async () => {
    if (socket === undefined) throw new TypeError("LANDO_GUIDE_E2E=1 requires an answering Podman socket");
    const directory = await mkdtemp(join(tmpdir(), "lando-backend-tls-live-"));
    const rootPath = join(directory, "root.pem");
    await writeFile(rootPath, pem.rootA, { mode: 0o644 });
    let peer: ReturnType<typeof Bun.serve> | undefined;
    try {
      const untrusted = await selfSignedPeer(directory, "untrusted.test.lndo.site");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* liveTraefikFixture(socket.socketPath);
            const owner = routeOwner("backend-tls-live");
            const service = fixture.makeService();
            if (service.prepare === undefined) throw new TypeError("Traefik preparation is required");
            yield* service.prepare(fixture.config);
            const startPeer = (material: PeerMaterial) => {
              peer?.stop(true);
              // The router container reaches the host through host.containers.internal,
              // which does not map host loopback.
              const server = Bun.serve({
                hostname: "0.0.0.0",
                port: 0,
                tls: { cert: material.certificate, key: material.privateKey },
                fetch: () => new Response("peer-ok"),
              });
              peer = server;
              if (server.port === undefined) throw new TypeError("Backend peer did not bind a port");
              return server.port;
            };
            // Each case applies a fresh route and therefore opens a fresh upstream
            // connection, so keep-alive cannot hide a changed peer certificate.
            let sequence = 0;
            const verify = (input: {
              readonly material: PeerMaterial;
              readonly serverName: string;
              readonly expected: "peer-ok" | "upstream-failure";
            }) => {
              sequence += 1;
              const hostname = `backend-tls-${sequence}.test.lndo.site`;
              const route: RoutePlan = {
                hostname,
                scheme: "https",
                priority: 100000,
                service: ServiceName.make("peer"),
                backend: {
                  service: ServiceName.make("peer"),
                  protocol: "https",
                  port: startPeer(input.material),
                  host: "host.containers.internal",
                  tls: { caId: "fixture-ca", serverName: input.serverName },
                },
              };
              return service.applyRoutes([route], owner).pipe(
                Effect.flatMap(() =>
                  Effect.promise(() =>
                    requestThroughRouter({ hostname, port: fixture.httpsPort, caPath: rootPath }),
                  ),
                ),
                Effect.map((response) => ({ ...response, expected: input.expected })),
              );
            };
            // Trusted leaf: the peer serves the configured root's certificate.
            const trusted = yield* verify({
              material: pem.current,
              serverName: "backend-tls-1.test.lndo.site",
              expected: "peer-ok",
            });
            expect(trusted.status).toBe(200);
            expect(trusted.body).toBe("peer-ok");
            // Unrelated signing root: the router must fail the upstream, never
            // forward the peer's success marker.
            const unrelated = yield* verify({
              material: untrusted,
              serverName: "backend-tls-2.test.lndo.site",
              expected: "upstream-failure",
            });
            // Traefik answers a failed backend verification with 500 (502 when it cannot connect).
            expect([500, 502]).toContain(unrelated.status);
            expect(unrelated.body).not.toContain("peer-ok");
            // Trusted root, wrong name: verification still fails.
            const mismatched = yield* verify({
              material: pem.current,
              serverName: "mismatch.example.test",
              expected: "upstream-failure",
            });
            expect([500, 502]).toContain(mismatched.status);
            expect(mismatched.body).not.toContain("peer-ok");
            console.info("Traefik backend TLS evidence", JSON.stringify({ trusted, unrelated, mismatched }));
          }).pipe(Effect.provide(liveTraefikLayers)),
        ),
      );
    } finally {
      peer?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  180000,
);
