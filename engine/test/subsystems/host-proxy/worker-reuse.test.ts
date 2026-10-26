import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
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

test.each(["exact", "adopt"] as const)(
  "%s fails closed for invalid endpoints, identities and configure failures",
  async (reusePolicy) => {
    // Given authenticated TCP control and a separately mounted private Unix socket.
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
      protocolVersion: 2,
      transport: "tcp-host-gateway",
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
    const socket = createServer();
    try {
      await mkdir(dirname(socketPath), { recursive: true });
      await writeFile(shimPath, "shim");
      await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
      const address = control.address();
      if (address === null || typeof address === "string") throw new Error("Missing control listener");
      await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
      await chmod(socketPath, 0o600);
      const record = {
        ...identity,
        appRoot: app.root,
        providerId: plan.provider,
        transport: "unix-socket" as const,
        protocolVersion: 2 as const,
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
            { app, plan, paths, shimArtifactPath: shimPath, privateFileAccess, reusePolicy },
            "digest",
          ),
        );
      expect((await ensure())?.sessionId).toBe("session");
      expect(configurations).toBe(1);

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
        socket.close((error) => (error ? reject(error) : resolve())),
      );
      await writeFile(socketPath, "not a socket", { mode: 0o600 });

      // Then even a healthy TCP control endpoint cannot prove a regular file is a reusable socket.
      expect(await ensure()).toBeUndefined();
      await rm(socketPath);
      await symlink(shimPath, socketPath);
      expect(await ensure()).toBeUndefined();
    } finally {
      socket.close();
      control.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
