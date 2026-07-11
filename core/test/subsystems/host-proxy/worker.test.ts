import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Exit, Fiber } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  hostProxyMountInfoFromPlan,
  hostProxyWorkerArgv,
  hostProxyWorkerOwnerMarker,
  removeOwnedHostProxyWorkerState,
  startDetachedHostProxyWorker,
  terminateOwnedHostProxyWorker,
  terminateOwnedHostProxyWorkersInRoot,
  workerOwnershipPath,
} from "../../../src/subsystems/host-proxy/worker.ts";

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };
const spacedApp = {
  kind: "user" as const,
  id: "demo app",
  root: AbsolutePath.make("/srv/apps/demo-app"),
};
const plan: AppPlan = {
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: AbsolutePath.make("/srv/apps/demo"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    source: "worker.test",
    runtime: 4,
  },
  extensions: {},
};

const servicePlan = (name: string, target: string, eligible = true): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: ProviderId.make("lando"),
  primary: name === "appserver",
  environment: {},
  appMount: {
    source: AbsolutePath.make("/srv/apps/demo"),
    target: PortablePath.make(target),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    source: "worker.test",
    runtime: 4,
  },
  extensions: eligible ? { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } } : {},
});

const ownedWorkerArgv = (appId: string): ReadonlyArray<string> => [
  ...hostProxyWorkerArgv({ appId }),
  hostProxyWorkerOwnerMarker(appId),
];

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-host-proxy-worker-"));

describe("detached host-proxy worker manager", () => {
  test("starts a detached worker, persists non-secret ownership, and returns secret session from readiness only", async () => {
    const root = await tempRoot();
    const writes: string[] = [];
    try {
      const session = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 12345,
            argv: spec.argv,
            writeStdin: async (value) => {
              writes.push(value);
            },
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      const ownership = await readFile(workerOwnershipPath(app, { userDataRoot: root }), "utf8");

      expect(session.token).toBe("secret-token");
      expect(writes[0]).toContain('"id":"demo"');
      expect(writes.join("\n")).not.toContain("secret-token");
      expect(ownership).toContain('"pid": 12345');
      expect(ownership).not.toContain("secret-token");
      expect(ownership).toContain("argvFingerprint");
      expect(ownership).toContain("--app-id");
      expect(ownership).toContain("demo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates argv fingerprint before terminating an owned worker", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 23456,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );
      await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, {
          paths: { userDataRoot: root },
          readProcessArgv: async () => hostProxyWorkerArgv({ entryPath: "/repo/core/bin/lando.ts" }),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([]);

      await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, {
          paths: { userDataRoot: root },
          readProcessArgv: async () => hostProxyWorkerArgv({ appId: "other" }),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([]);

      await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, {
          paths: { userDataRoot: root },
          readProcessArgv: async () => ownedWorkerArgv("demo"),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([23456]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves ownership state when cleanup cannot verify the recorded worker", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 34567,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(
        removeOwnedHostProxyWorkerState(
          app,
          { userDataRoot: root },
          {
            readProcessArgv: async () => hostProxyWorkerArgv({ appId: "other" }),
            terminateProcess: async (pid) => {
              terminated.push(pid);
            },
          },
        ),
      );

      expect(terminated).toEqual([]);
      expect(await readFile(workerOwnershipPath(app, { userDataRoot: root }), "utf8")).toContain(
        '"pid": 34567',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes ownership state after verified cleanup termination", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 45678,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(
        removeOwnedHostProxyWorkerState(
          app,
          { userDataRoot: root },
          {
            readProcessArgv: async () => ownedWorkerArgv("demo"),
            terminateProcess: async (pid) => {
              terminated.push(pid);
            },
          },
        ),
      );

      expect(terminated).toEqual([45678]);
      await expect(Bun.file(workerOwnershipPath(app, { userDataRoot: root })).exists()).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a verified owned worker for the same app before spawning the next worker", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 11111,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token-1",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      const replacement = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          readProcessArgv: async () => ownedWorkerArgv("demo"),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
          spawnWorker: (spec) => ({
            pid: 22222,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-2",
              token: "secret-token-2",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      const ownership = await readFile(workerOwnershipPath(app, { userDataRoot: root }), "utf8");
      expect(terminated).toEqual([11111]);
      expect(replacement.sessionId).toBe("session-2");
      expect(ownership).toContain('"pid": 22222');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses repeat start when the existing worker fingerprint is unowned", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    let spawnCount = 0;
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => {
            spawnCount += 1;
            return {
              pid: 33333,
              argv: spec.argv,
              writeStdin: async () => undefined,
              readReady: async () => ({
                _tag: "ready" as const,
                appId: "demo",
                sessionId: "session-1",
                token: "secret-token-1",
                socketPath: join(root, "run", "demo", "host-proxy.sock"),
                shimPath: join(root, "run", "demo", "lando"),
              }),
              terminate: async () => undefined,
            };
          },
        }),
      );

      const exit = await Effect.runPromiseExit(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          readProcessArgv: async () => hostProxyWorkerArgv({ appId: "other" }),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
          spawnWorker: (spec) => {
            spawnCount += 1;
            return {
              pid: 44444,
              argv: spec.argv,
              writeStdin: async () => undefined,
              readReady: async () => ({
                _tag: "ready" as const,
                appId: "demo",
                sessionId: "session-2",
                token: "secret-token-2",
                socketPath: join(root, "run", "demo", "host-proxy.sock"),
                shimPath: join(root, "run", "demo", "lando"),
              }),
              terminate: async () => undefined,
            };
          },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminated).toEqual([]);
      expect(spawnCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses default Darwin command inspection and refuses unverified worker identity", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 24680,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );
      await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, {
          paths: { userDataRoot: root },
          platform: "darwin",
          readProcessCommand: async () => `${hostProxyWorkerArgv({ appId: "other" }).join(" ")}`,
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([]);

      await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, {
          paths: { userDataRoot: root },
          platform: "darwin",
          readProcessCommand: async () => `bun ${hostProxyWorkerOwnerMarker("demo")}`,
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([24680]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses marker-based Darwin command ownership when app ids contain spaces", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app: spacedApp,
          plan: { ...plan, id: AppId.make("demo app"), root: spacedApp.root },
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 24681,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo app",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo-app", "host-proxy.sock"),
              shimPath: join(root, "run", "demo-app", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(
        terminateOwnedHostProxyWorker(spacedApp, {
          paths: { userDataRoot: root },
          platform: "darwin",
          readProcessCommand: async () => `bun path with spaces ${hostProxyWorkerOwnerMarker("demo app")}`,
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([24681]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the default Windows CIM command-line reader through the injectable spawn seam", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 24682,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, {
          paths: { userDataRoot: root },
          platform: "win32",
          spawnProcessCommand: async (argv) => {
            expect(argv.join(" ")).toContain("Get-CimInstance");
            expect(argv.join(" ")).toContain("24682");
            return {
              exitCode: 0,
              stdout: `bun.exe C:\\Program Files\\Lando\\lando ${hostProxyWorkerOwnerMarker("demo")}`,
            };
          },
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([24682]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates owned workers under a run root and ignores mismatched fingerprints", async () => {
    const root = await tempRoot();
    const terminated: number[] = [];
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 34567,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(root, {
          readProcessArgv: async () => hostProxyWorkerArgv({ entryPath: "/repo/core/bin/lando.ts" }),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );
      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(root, {
          readProcessArgv: async () => ownedWorkerArgv("demo"),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([34567]);
      expect(await Bun.file(workerOwnershipPath(app, { userDataRoot: root })).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes only verified owned worker directories under the run root", async () => {
    const root = await tempRoot();
    const tunnelsDir = join(root, "run", "tunnels");
    try {
      await mkdir(tunnelsDir, { recursive: true });
      await writeFile(join(tunnelsDir, "registry.json"), "{}\n", "utf8");
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 56789,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(root, "run", "demo", "host-proxy.sock"),
              shimPath: join(root, "run", "demo", "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(root, {
          readProcessArgv: async () => ownedWorkerArgv("demo"),
          terminateProcess: async () => undefined,
        }),
      );

      expect(await Bun.file(join(root, "run", "demo")).exists()).toBe(false);
      expect(await Bun.file(join(tunnelsDir, "registry.json")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans verified worker directory when app id is sanitized in the run path", async () => {
    const root = await tempRoot();
    const runDir = join(root, "run", "demo-app");
    const unrelatedDir = join(root, "run", "other-app");
    try {
      await mkdir(unrelatedDir, { recursive: true });
      await writeFile(join(unrelatedDir, "keep.txt"), "keep\n", "utf8");
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app: spacedApp,
          plan: { ...plan, id: AppId.make("demo app"), root: spacedApp.root },
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 67890,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo app",
              sessionId: "session-1",
              token: "secret-token",
              socketPath: join(runDir, "host-proxy.sock"),
              shimPath: join(runDir, "lando"),
            }),
            terminate: async () => undefined,
          }),
        }),
      );
      expect(workerOwnershipPath(spacedApp, { userDataRoot: root })).toBe(join(runDir, "worker.json"));
      expect(await Bun.file(join(runDir, "worker.json")).exists()).toBe(true);
      expect(await Bun.file(join(runDir, "worker.json")).text()).toContain('"appId": "demo app"');

      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(root, {
          readProcessArgv: async () => ownedWorkerArgv("demo app"),
          terminateProcess: async () => undefined,
        }),
      );

      expect(await Bun.file(runDir).exists()).toBe(false);
      expect(await Bun.file(join(unrelatedDir, "keep.txt")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates the spawned worker when startup is interrupted before readiness", async () => {
    const root = await tempRoot();
    let terminateCount = 0;
    try {
      const fiber = Effect.runFork(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: "/tmp/fake-shim",
          spawnWorker: (spec) => ({
            pid: 45678,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: () => new Promise(() => undefined),
            terminate: async () => {
              terminateCount += 1;
            },
          }),
        }),
      );

      await Effect.runPromise(Effect.sleep("10 millis").pipe(Effect.zipRight(Fiber.interrupt(fiber))));

      expect(terminateCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("derives host-proxy mount info from the first eligible service", () => {
    const mountInfo = hostProxyMountInfoFromPlan({
      ...plan,
      services: {
        [ServiceName.make("database")]: servicePlan("database", "/db", false),
        [ServiceName.make("appserver")]: servicePlan("appserver", "/workspace"),
      },
    });

    expect(mountInfo).toEqual({ containerRoot: "/workspace", hostRoot: "/srv/apps/demo" });
  });

  test("falls back to the plan root when no service is host-proxy eligible", () => {
    const mountInfo = hostProxyMountInfoFromPlan({
      ...plan,
      services: {
        [ServiceName.make("database")]: servicePlan("database", "/db", false),
      },
    });

    expect(mountInfo).toEqual({ containerRoot: "/app", hostRoot: "/srv/apps/demo" });
  });
});
