import { expect, test } from "bun:test";
import { chmod, chown, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { HOST_PROXY_WORKER_PROTOCOL_VERSION } from "../../../src/subsystems/host-proxy/worker-records.ts";
import { reuseHostProxyWorker } from "../../../src/subsystems/host-proxy/worker-reuse.ts";
import { workerStatePath, writeWorkerRecord } from "../../../src/subsystems/host-proxy/worker-state-file.ts";

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };
const plan = Schema.decodeUnknownSync(AppPlan)({
  id: app.id,
  name: "demo",
  slug: "demo",
  root: app.root,
  provider: "lando",
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 },
});

for (const reusePolicy of ["exact", "adopt"] as const) {
  for (const ownership of ["current", "foreign-socket", "foreign-directory"] as const) {
    test.skipIf(ownership !== "current" && process.getuid?.() !== 0)(
      `${reusePolicy} fails closed for invalid endpoints, identities and configure failures (${ownership})`,
      async () => {
        // Given authenticated control through a private host Unix socket.
        const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-reuse-"));
        const paths = { userDataRoot: root };
        const socketPath = join(dirname(workerStatePath(app, paths)), "host-proxy.sock");
        const shimPath = join(root, "shim");
        const privateFileAccess = await Effect.runPromise(
          Effect.scoped(PrivateFileAccessService.pipe(Effect.provide(PrivateFileAccessService.layer))),
        );
        let identityRoot: string | undefined = app.root;
        let identityProvider: string | undefined = plan.provider;
        let configureStatus = 200;
        let configurations = 0;
        const identity = {
          appId: app.id,
          sessionId: "session",
          configDigest: "digest",
          pid: process.pid,
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          transport: "unix-socket",
          bridge: "none" as const,
        };
        const control = createServer((request, response) => {
          if (
            request.headers["x-lando-host-proxy-control"] !== "control" ||
            request.headers.authorization !== "Bearer bearer" ||
            request.headers["x-lando-host-proxy-session"] !== "session" ||
            request.headers["x-lando-host-proxy-app"] !== app.id
          ) {
            response.writeHead(401).end();
            return;
          }
          if (request.url === "/_lando/host-proxy/configure") {
            configurations++;
            request.resume();
            response.writeHead(configureStatus).end();
            return;
          }
          response
            .writeHead(200)
            .end(JSON.stringify({ ...identity, appRoot: identityRoot, providerId: identityProvider }));
        });
        try {
          await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
          await writeFile(shimPath, "shim");
          await new Promise<void>((resolve) => control.listen(socketPath, resolve));
          await chmod(socketPath, 0o666);
          const record = {
            ...identity,
            appRoot: app.root,
            providerId: plan.provider,
            transport: "unix-socket" as const,
            protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
            token: "bearer",
            controlToken: "control",
            socketPath,
            shimPath,
            startedAt: "2026-01-01T00:00:00Z",
          };
          await Effect.runPromise(writeWorkerRecord(app, paths, record, privateFileAccess));
          const ensure = () =>
            Effect.runPromise(
              reuseHostProxyWorker(
                { app, plan, paths, shimArtifactPath: shimPath, privateFileAccess, reusePolicy },
                "digest",
              ),
            );
          expect((await ensure())?.sessionId).toBe("session");
          expect(configurations).toBe(1);

          if (ownership !== "current") {
            const foreignPath = ownership === "foreign-socket" ? socketPath : dirname(socketPath);
            try {
              await chown(foreignPath, 65534, 65534);
              expect(await ensure()).toBeUndefined();
              expect(configurations).toBe(1);
            } finally {
              await chown(foreignPath, 0, 0);
            }
            return;
          }

          // When host directory privacy is lost, the otherwise live socket cannot be reused.
          await chmod(dirname(socketPath), 0o755);
          expect(await ensure()).toBeUndefined();
          await chmod(dirname(socketPath), 0o700);

          // When any current-protocol ownership identity is absent or foreign, reuse is rejected.
          for (const value of [undefined, "/foreign"]) {
            identityRoot = value;
            expect(await ensure()).toBeUndefined();
          }
          identityRoot = app.root;
          for (const value of [undefined, "docker"]) {
            identityProvider = value;
            expect(await ensure()).toBeUndefined();
          }
          identityProvider = plan.provider;
          configureStatus = 400;
          expect(await ensure()).toBeUndefined();
          configureStatus = 200;
          await new Promise<void>((resolve, reject) =>
            control.close((error) => (error ? reject(error) : resolve())),
          );
          await writeFile(socketPath, "not a socket", { mode: 0o600 });

          // Then a regular file or symlink cannot stand in for the host socket.
          expect(await ensure()).toBeUndefined();
          await rm(socketPath);
          await symlink(shimPath, socketPath);
          expect(await ensure()).toBeUndefined();
        } finally {
          control.close();
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

test.each(["unix-socket", "tcp-host-gateway"] as const)(
  "reuse of %s with a guest socket requires a live bridge",
  async (transport) => {
    // Given: a fully owned worker whose control plane is healthy except bridge liveness.
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-reuse-dead-bridge-"));
    const paths = { userDataRoot: root };
    const socketPath = join(root, "nonexistent-guest", "host-proxy.sock");
    const shimPath = join(root, "shim");
    const privateFileAccess = await Effect.runPromise(
      Effect.scoped(PrivateFileAccessService.pipe(Effect.provide(PrivateFileAccessService.layer))),
    );
    let bridge: "alive" | "dead" = "alive";
    const identity = {
      appId: app.id,
      sessionId: "session",
      configDigest: "digest",
      pid: process.pid,
      protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
      transport: "tcp-host-gateway" as const,
      appRoot: app.root,
      providerId: plan.provider,
      get bridge() {
        return bridge;
      },
    };
    const control = createServer((request, response) => {
      if (
        request.headers["x-lando-host-proxy-control"] !== "control" ||
        request.headers.authorization !== "Bearer bearer" ||
        request.headers["x-lando-host-proxy-session"] !== "session" ||
        request.headers["x-lando-host-proxy-app"] !== app.id
      ) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === "/_lando/host-proxy/configure") {
        request.resume();
        response.writeHead(200).end();
        return;
      }
      response.writeHead(200).end(JSON.stringify(identity));
    });
    try {
      await writeFile(shimPath, "shim");
      await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
      const address = control.address();
      if (address === null || typeof address === "string") throw new Error("Missing control listener");
      const record = {
        appId: app.id,
        appRoot: app.root,
        providerId: plan.provider,
        sessionId: "session",
        configDigest: "digest",
        pid: process.pid,
        transport,
        protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
        token: "bearer",
        controlToken: "control",
        socketPath,
        shimPath,
        startedAt: "2026-01-01T00:00:00Z",
        url: `http://127.0.0.1:${address.port}`,
      };
      await Effect.runPromise(writeWorkerRecord(app, paths, record, privateFileAccess));
      const ensure = () =>
        Effect.runPromise(
          reuseHostProxyWorker(
            { app, plan, paths, shimArtifactPath: shimPath, privateFileAccess, reusePolicy: "exact" },
            "digest",
          ),
        );
      // When: the bridge is still alive, reuse succeeds.
      expect((await ensure())?.sessionId).toBe("session");
      // When: the reverse-forward process has exited, identify reports dead.
      bridge = "dead";
      // Then: reuse fails closed so the owning start replaces the worker.
      expect(await ensure()).toBeUndefined();
    } finally {
      control.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
