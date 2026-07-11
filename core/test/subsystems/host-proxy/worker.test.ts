import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

import {
  hostProxyWorkerArgv,
  startDetachedHostProxyWorker,
  terminateOwnedHostProxyWorker,
  terminateOwnedHostProxyWorkersInRoot,
  workerOwnershipPath,
} from "../../../src/subsystems/host-proxy/worker.ts";

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };
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
      expect(writes.join("\n")).not.toContain("secret-token");
      expect(ownership).toContain('"pid": 12345');
      expect(ownership).not.toContain("secret-token");
      expect(ownership).toContain("argvFingerprint");
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
          readProcessArgv: async () => hostProxyWorkerArgv(),
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
          readProcessArgv: async () => hostProxyWorkerArgv(),
          terminateProcess: async (pid) => {
            terminated.push(pid);
          },
        }),
      );

      expect(terminated).toEqual([34567]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
