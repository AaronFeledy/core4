import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DateTime, Effect, Fiber } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { makeLandoPaths, sanitizeAppName } from "../../../src/config/paths.ts";
import { HOST_PROXY_RUN_LANDO_ENV_NAMES } from "../../../src/subsystems/host-proxy/session-env.ts";
import { defaultSpawnWorker } from "../../../src/subsystems/host-proxy/worker-process.ts";
import {
  HOST_PROXY_WORKER_PROTOCOL_VERSION,
  type HostProxyWorkerRecord,
  probeWorker,
  readWorkerRecord,
  writeWorkerRecord,
} from "../../../src/subsystems/host-proxy/worker-state.ts";
import {
  hostProxyMountInfoFromPlan,
  hostProxyWorkerArgv,
  removeOwnedHostProxyWorkerState,
  startDetachedHostProxyWorker,
  terminateOwnedHostProxyWorker,
  terminateOwnedHostProxyWorkersInRoot,
  workerStatePath,
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

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-host-proxy-worker-"));

const fakeShim = async (root: string): Promise<string> => {
  const path = join(root, "shim");
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

const killLeakedWorkers = async (): Promise<void> => {
  const proc = Bun.spawn(["pgrep", "-f", "__internal:host-proxy-worker"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (exitCode !== 0) return;
  for (const raw of stdout.split("\n")) {
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
};

const hasNodeCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (hasNodeCode(cause, "ESRCH")) return false;
    return true;
  }
};

const waitForPidExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!pidIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process ${pid} stayed alive after host-proxy shutdown.`);
};

afterEach(killLeakedWorkers);

const workerRecord = (
  root: string,
  overrides: { readonly socketPath?: string; readonly pid?: number } = {},
): HostProxyWorkerRecord & { readonly socketPath: string } => {
  const runDir = dirname(workerStatePath(app, { userDataRoot: root }));
  return {
    appId: app.id,
    appRoot: app.root,
    transport: "unix-socket",
    socketPath: overrides.socketPath ?? join(runDir, "host-proxy.sock"),
    shimPath: join(runDir, "lando"),
    protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
    startedAt: "2026-01-01T00:00:00.000Z",
    pid: overrides.pid ?? 12345,
    controlToken: "control-token",
  };
};

type TestControlRecord = Omit<HostProxyWorkerRecord, "appRoot" | "socketPath"> & {
  readonly socketPath: string;
};

const legacyWorkerRecord = (root: string): TestControlRecord => {
  const runDir = join(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot, sanitizeAppName(app.id));
  return {
    appId: app.id,
    transport: "unix-socket",
    socketPath: join(runDir, "host-proxy.sock"),
    shimPath: join(runDir, "lando"),
    protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
    startedAt: "2026-01-01T00:00:00.000Z",
    pid: 12345,
    controlToken: "control-token",
  };
};

const listenControlServerForRecord = async <Record extends TestControlRecord>(
  record: Record,
): Promise<{
  readonly record: Record;
  readonly server: ReturnType<typeof createServer>;
  readonly shutdowns: () => number;
}> => {
  let shutdowns = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "", "http://control.invalid").pathname;
    if (request.headers["x-lando-host-proxy-control"] !== record.controlToken) {
      response.writeHead(401).end();
      return;
    }
    if (pathname === "/_lando/host-proxy/identify") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          appId: record.appId,
          sessionId: "session-1",
          transport: record.transport,
          protocolVersion: record.protocolVersion,
          pid: record.pid,
        }),
      );
      return;
    }
    if (pathname === "/_lando/host-proxy/shutdown") {
      shutdowns += 1;
      response.writeHead(202).end();
      setImmediate(() => server.close());
      return;
    }
    response.writeHead(404).end();
  });
  const socketPath = record.socketPath;
  await mkdir(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  return { record, server, shutdowns: () => shutdowns };
};

const listenControlServer = async (root: string) => listenControlServerForRecord(workerRecord(root));

describe("detached host-proxy worker manager", () => {
  test("starts a detached worker, persists socket-owned state, and keeps session token out of worker.json", async () => {
    const root = await tempRoot();
    const writes: string[] = [];
    try {
      const session = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
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
              controlToken: "control-token",
              socketPath: join(dirname(workerStatePath(app, { userDataRoot: root })), "host-proxy.sock"),
              shimPath: join(dirname(workerStatePath(app, { userDataRoot: root })), "lando"),
              transport: "unix-socket" as const,
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      const record = await readFile(workerStatePath(app, { userDataRoot: root }), "utf8");

      expect(session.token).toBe("secret-token");
      expect(session.controlToken).toBe("control-token");
      expect(writes[0]).toContain('"id":"demo"');
      expect(writes.join("\n")).not.toContain("secret-token");
      expect(record).toContain('"controlToken": "control-token"');
      expect(record).toContain('"protocolVersion": 1');
      expect(record).not.toContain("secret-token");
      expect(hostProxyWorkerArgv({ appId: "demo" })).toEqual(expect.arrayContaining(["--app-id", "demo"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates worker state for the same app id in different app roots", async () => {
    const root = await tempRoot();
    const firstApp = { ...app, root: AbsolutePath.make("/srv/apps/first/demo") };
    const secondApp = { ...app, root: AbsolutePath.make("/srv/apps/second/demo") };
    const start = (currentApp: typeof app, pid: number) =>
      startDetachedHostProxyWorker({
        app: currentApp,
        plan: { ...plan, root: currentApp.root },
        paths: { userDataRoot: root },
        shimArtifactPath: join(root, "shim"),
        spawnWorker: (spec) => ({
          pid,
          argv: spec.argv,
          writeStdin: async () => undefined,
          readReady: async () => {
            const runDir = dirname(workerStatePath(currentApp, { userDataRoot: root }));
            return {
              _tag: "ready",
              appId: currentApp.id,
              sessionId: `session-${pid}`,
              token: `secret-${pid}`,
              controlToken: `control-${pid}`,
              socketPath: join(runDir, "host-proxy.sock"),
              shimPath: join(runDir, "lando"),
              transport: "unix-socket",
            };
          },
          terminate: async () => undefined,
        }),
      });
    try {
      await writeFile(join(root, "shim"), "#!/usr/bin/env sh\nexit 0\n");
      const first = await Effect.runPromise(start(firstApp, 11111));
      const second = await Effect.runPromise(start(secondApp, 22222));

      const firstRecord = await Effect.runPromise(readWorkerRecord(firstApp, { userDataRoot: root }));
      const secondRecord = await Effect.runPromise(readWorkerRecord(secondApp, { userDataRoot: root }));

      expect(workerStatePath(firstApp, { userDataRoot: root })).not.toBe(
        workerStatePath(secondApp, { userDataRoot: root }),
      );
      expect(firstRecord?.pid).toBe(11111);
      expect(firstRecord?.appRoot).toBe(firstApp.root);
      expect(secondRecord?.pid).toBe(22222);
      expect(secondRecord?.appRoot).toBe(secondApp.root);
      await first.close();
      await second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("spawns the worker with inherited non-session env and without host-proxy session env", async () => {
    const root = await tempRoot();
    const preservedEnvName = "LANDO_HOST_PROXY_WORKER_TEST_PRESERVE";
    const priorEnv = Object.fromEntries(
      [preservedEnvName, ...HOST_PROXY_RUN_LANDO_ENV_NAMES].map((name) => [name, process.env[name]]),
    );
    try {
      for (const name of HOST_PROXY_RUN_LANDO_ENV_NAMES) process.env[name] = `leaked-${name}`;
      process.env[preservedEnvName] = "preserved-value";
      const scriptPath = join(root, "env-worker.ts");
      await writeFile(
        scriptPath,
        `const denied = ${JSON.stringify(HOST_PROXY_RUN_LANDO_ENV_NAMES)};
const leaked = denied.filter((name) => process.env[name] !== undefined);
console.log(JSON.stringify({
  _tag: "ready",
  appId: "demo",
  sessionId: "session-env",
  token: JSON.stringify(leaked),
  controlToken: process.env[${JSON.stringify(preservedEnvName)}] ?? "",
  socketPath: ${JSON.stringify(join(root, "host-proxy.sock"))},
  shimPath: ${JSON.stringify(join(root, "lando"))}
}));
`,
      );

      const worker = defaultSpawnWorker({ argv: [process.execPath, scriptPath] });
      const ready = await worker.readReady();

      expect(JSON.parse(ready.token)).toEqual([]);
      expect(ready.controlToken).toBe("preserved-value");
    } finally {
      for (const [name, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("probes live ownership through the control endpoint", async () => {
    const root = await tempRoot();
    const { record, server } = await listenControlServer(root);
    try {
      expect(await Effect.runPromise(probeWorker(record))).toBe("live");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects control identity when the worker pid does not match persisted state", async () => {
    const root = await tempRoot();
    const { record, server } = await listenControlServer(root);
    try {
      expect(await Effect.runPromise(probeWorker({ ...record, pid: record.pid + 1 }))).toBe("dead");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes dead worker state without inspecting the process table", async () => {
    const root = await tempRoot();
    try {
      await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, workerRecord(root)));

      const result = await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, { paths: { userDataRoot: root } }),
      );

      expect(result).toBe("terminated");
      expect(await Bun.file(workerStatePath(app, { userDataRoot: root })).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes stale run directory when owned worker record is absent", async () => {
    const root = await tempRoot();
    const runDir = dirname(workerStatePath(app, { userDataRoot: root }));
    try {
      await mkdir(join(runDir, "mounts"), { recursive: true });
      await writeFile(join(runDir, "host-proxy.sock"), "stale socket");
      await writeFile(join(runDir, "lando"), "stale shim");
      await writeFile(join(runDir, "mounts", "appserver.json"), "{}");

      const result = await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, { paths: { userDataRoot: root } }),
      );

      expect(result).toBe("absent");
      expect(existsSync(runDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shuts down a live identified worker before removing state", async () => {
    const root = await tempRoot();
    const control = await listenControlServer(root);
    try {
      await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, control.record));

      const result = await Effect.runPromise(
        terminateOwnedHostProxyWorker(app, { paths: { userDataRoot: root } }),
      );

      expect(result).toBe("terminated");
      expect(control.shutdowns()).toBe(1);
      expect(await Bun.file(workerStatePath(app, { userDataRoot: root })).exists()).toBe(false);
    } finally {
      control.server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a live worker before spawning the next worker", async () => {
    const root = await tempRoot();
    const control = await listenControlServer(root);
    const terminatedNewWorkers: number[] = [];
    try {
      await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, control.record));

      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
          spawnWorker: () => ({
            pid: 56789,
            argv: hostProxyWorkerArgv({ appId: "demo" }),
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo",
              sessionId: "session-2",
              token: "secret-token-2",
              controlToken: "control-token-2",
              socketPath: join(dirname(workerStatePath(app, { userDataRoot: root })), "host-proxy.sock"),
              shimPath: join(dirname(workerStatePath(app, { userDataRoot: root })), "lando"),
              transport: "unix-socket" as const,
            }),
            terminate: async () => {
              terminatedNewWorkers.push(56789);
            },
          }),
        }),
      );

      const record = await readFile(workerStatePath(app, { userDataRoot: root }), "utf8");
      expect(control.shutdowns()).toBe(1);
      expect(terminatedNewWorkers).toEqual([]);
      expect(record).toContain('"pid": 56789');
      expect(record).toContain("control-token-2");
    } finally {
      control.server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates the spawned worker when startup is interrupted before readiness", async () => {
    const root = await tempRoot();
    let terminated = 0;
    try {
      const fiber = Effect.runFork(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
          spawnWorker: (spec) => ({
            pid: 67890,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: () => new Promise(() => undefined),
            terminate: async () => {
              terminated += 1;
            },
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(terminated).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates the spawned worker when startup stdin write fails", async () => {
    const root = await tempRoot();
    let terminated = 0;
    try {
      const exit = await Effect.runPromiseExit(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
          spawnWorker: (spec) => ({
            pid: 67901,
            argv: spec.argv,
            writeStdin: async () => {
              throw new Error("stdin failed");
            },
            readReady: async () => {
              throw new Error("readiness should not run");
            },
            terminate: async () => {
              terminated += 1;
            },
          }),
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(terminated).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("control-plane shutdown makes the real detached worker process exit", async () => {
    const root = await tempRoot();
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
        }),
      );
      const record = await Effect.runPromise(readWorkerRecord(app, { userDataRoot: root }));
      if (record === undefined) throw new Error("Expected worker record after startup.");

      await Effect.runPromise(terminateOwnedHostProxyWorker(app, { paths: { userDataRoot: root } }));
      await waitForPidExit(record.pid);

      expect(pidIsAlive(record.pid)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replacing a live real worker exits the old worker pid", async () => {
    const root = await tempRoot();
    try {
      const first = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
        }),
      );
      const firstRecord = await Effect.runPromise(readWorkerRecord(app, { userDataRoot: root }));
      if (firstRecord === undefined) throw new Error("Expected first worker record after startup.");

      const second = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
        }),
      );
      await waitForPidExit(firstRecord.pid);
      await second.close();

      expect(pidIsAlive(firstRecord.pid)).toBe(false);
      await first.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
      await killLeakedWorkers();
    }
  });

  test("terminates owned workers under a run root", async () => {
    const root = await tempRoot();
    const control = await listenControlServer(root);
    try {
      await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, control.record));

      await Effect.runPromise(terminateOwnedHostProxyWorkersInRoot(root));

      expect(control.shutdowns()).toBe(1);
      expect(await Bun.file(workerStatePath(app, { userDataRoot: root })).exists()).toBe(false);
    } finally {
      control.server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates and removes a legacy worker record under the old app-id run directory", async () => {
    const root = await tempRoot();
    const legacy = legacyWorkerRecord(root);
    const control = await listenControlServerForRecord(legacy);
    const runDir = dirname(legacy.socketPath);
    try {
      await writeFile(
        join(runDir, "worker.json"),
        `${JSON.stringify({
          appId: legacy.appId,
          transport: legacy.transport,
          socketPath: legacy.socketPath,
          shimPath: legacy.shimPath,
          protocolVersion: legacy.protocolVersion,
          startedAt: legacy.startedAt,
          pid: legacy.pid,
          controlToken: legacy.controlToken,
        })}\n`,
      );

      await Effect.runPromise(terminateOwnedHostProxyWorkersInRoot(root));

      expect(control.shutdowns()).toBe(1);
      expect(existsSync(runDir)).toBe(false);
    } finally {
      control.server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans worker directory when app id is sanitized in the run path", async () => {
    const root = await tempRoot();
    try {
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          app: spacedApp,
          plan: { ...plan, id: AppId.make("demo app") },
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
          spawnWorker: (spec) => ({
            pid: 78901,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready" as const,
              appId: "demo app",
              sessionId: "session-space",
              token: "secret-token",
              controlToken: "control-token",
              socketPath: join(
                dirname(workerStatePath(spacedApp, { userDataRoot: root })),
                "host-proxy.sock",
              ),
              shimPath: join(dirname(workerStatePath(spacedApp, { userDataRoot: root })), "lando"),
              transport: "unix-socket" as const,
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      await Effect.runPromise(removeOwnedHostProxyWorkerState(spacedApp, { userDataRoot: root }));

      expect(await Bun.file(workerStatePath(spacedApp, { userDataRoot: root })).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("derives host-proxy mount info from the first eligible service", () => {
    const first = servicePlan("appserver", "/workspace");
    const second = servicePlan("worker", "/worker");

    expect(
      hostProxyMountInfoFromPlan({ ...plan, services: { [first.name]: first, [second.name]: second } }),
    ).toEqual({
      containerRoot: "/workspace",
      hostRoot: "/srv/apps/demo",
    });
  });

  test("falls back to the plan root when no service is host-proxy eligible", () => {
    const service = servicePlan("appserver", "/workspace", false);

    expect(hostProxyMountInfoFromPlan({ ...plan, services: { [service.name]: service } })).toEqual({
      containerRoot: "/app",
      hostRoot: "/srv/apps/demo",
    });
  });
});
