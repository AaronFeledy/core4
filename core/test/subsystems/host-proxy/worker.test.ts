import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { encodeCommandResult } from "@lando/sdk/command-result";
import { DateTime, Effect, Exit, Fiber, Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  AppPlan,
  PortNumber,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { hostProxyWorkerEntry } from "@lando/engine/composition";
import { HOST_PROXY_RUN_LANDO_ENV_NAMES } from "@lando/engine/subsystems/host-proxy/session-env";
import { sendHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport";
import {
  hostProxyMountInfoFromPlan,
  hostProxyWorkerArgv,
  removeOwnedHostProxyWorkerState as removeOwnedHostProxyWorkerStateWithPrivateFileAccess,
  startDetachedHostProxyWorker as startDetachedHostProxyWorkerWithPrivateFileAccess,
  terminateOwnedHostProxyWorker as terminateOwnedHostProxyWorkerWithPrivateFileAccess,
  terminateOwnedHostProxyWorkersInRoot as terminateOwnedHostProxyWorkersInRootWithPrivateFileAccess,
  workerStatePath,
} from "@lando/engine/subsystems/host-proxy/worker";
import { defaultSpawnWorker } from "@lando/engine/subsystems/host-proxy/worker-process";
import {
  type HostProxyControlRecord,
  HostProxyWorkerIdentity,
} from "@lando/engine/subsystems/host-proxy/worker-records";
import {
  HOST_PROXY_WORKER_PROTOCOL_VERSION,
  type HostProxyWorkerRecord,
  probeWorker as probeWorkerWithPrivateFileAccess,
  readWorkerRecord as readWorkerRecordWithPrivateFileAccess,
  writeWorkerRecord as writeWorkerRecordWithPrivateFileAccess,
} from "@lando/engine/subsystems/host-proxy/worker-state";
import { readWorkerRecordStateAt } from "@lando/engine/subsystems/host-proxy/worker-state-file";
import { makeLandoPaths, sanitizeAppName } from "@lando/paths";
import "../../../src/runtime/engine-composition.ts";
import { ownerOnlyFileAccess } from "../../_support/private-file-access.ts";

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
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
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
  mounts: [
    {
      type: "bind",
      source: AbsolutePath.make("/srv/apps/demo"),
      target: PortablePath.make(target),
      readOnly: false,
      excludes: [],
      includes: [],
      realization: "passthrough",
      role: "app",
    },
  ],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    source: "worker.test",
    runtime: 4,
  },
  extensions: eligible ? { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } } : {},
});

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-host-proxy-worker-"));
const spawnedPids = new Set<number>();
const startDetachedHostProxyWorker = (
  options: Omit<
    Parameters<typeof startDetachedHostProxyWorkerWithPrivateFileAccess>[0],
    "privateFileAccess"
  > & {
    readonly privateFileAccess?: Parameters<
      typeof startDetachedHostProxyWorkerWithPrivateFileAccess
    >[0]["privateFileAccess"];
  },
) =>
  startDetachedHostProxyWorkerWithPrivateFileAccess({
    ...options,
    privateFileAccess: options.privateFileAccess ?? ownerOnlyFileAccess,
    spawnWorker: async (spec) => {
      const worker = await (options.spawnWorker ?? defaultSpawnWorker)(spec);
      if (options.spawnWorker === undefined) spawnedPids.add(worker.pid);
      return worker;
    },
  });
const terminateOwnedHostProxyWorker = (
  app: Parameters<typeof terminateOwnedHostProxyWorkerWithPrivateFileAccess>[0],
  options: Omit<
    Parameters<typeof terminateOwnedHostProxyWorkerWithPrivateFileAccess>[1],
    "privateFileAccess"
  >,
) =>
  terminateOwnedHostProxyWorkerWithPrivateFileAccess(app, {
    ...options,
    privateFileAccess: ownerOnlyFileAccess,
  });
const terminateOwnedHostProxyWorkersInRoot = (
  userDataRoot: Parameters<typeof terminateOwnedHostProxyWorkersInRootWithPrivateFileAccess>[0],
) =>
  terminateOwnedHostProxyWorkersInRootWithPrivateFileAccess(userDataRoot, {
    privateFileAccess: ownerOnlyFileAccess,
  });
const writeWorkerRecord = (
  app: Parameters<typeof writeWorkerRecordWithPrivateFileAccess>[0],
  paths: Parameters<typeof writeWorkerRecordWithPrivateFileAccess>[1],
  record: Parameters<typeof writeWorkerRecordWithPrivateFileAccess>[2],
) => writeWorkerRecordWithPrivateFileAccess(app, paths, record, ownerOnlyFileAccess);
const readWorkerRecord = (
  app: Parameters<typeof readWorkerRecordWithPrivateFileAccess>[0],
  paths?: Parameters<typeof readWorkerRecordWithPrivateFileAccess>[1],
) => readWorkerRecordWithPrivateFileAccess(app, paths);
const probeWorker = (record: Parameters<typeof probeWorkerWithPrivateFileAccess>[0]) =>
  probeWorkerWithPrivateFileAccess(record);
const removeOwnedHostProxyWorkerState = (
  app: Parameters<typeof removeOwnedHostProxyWorkerStateWithPrivateFileAccess>[0],
  paths: Parameters<typeof removeOwnedHostProxyWorkerStateWithPrivateFileAccess>[1],
) =>
  removeOwnedHostProxyWorkerStateWithPrivateFileAccess(app, paths, {
    privateFileAccess: ownerOnlyFileAccess,
  });
const workerEntry = hostProxyWorkerEntry();

const fakeShim = async (root: string): Promise<string> => {
  const path = join(root, "shim");
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

const killLeakedWorkers = async (): Promise<void> => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (cause) {
      if (!(cause instanceof Error && hasNodeCode(cause, "ESRCH"))) throw cause;
    }
  }
  spawnedPids.clear();
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

test.each(["interruption", "failure"] as const)(
  "ownership record write %s preserves worker ownership semantics",
  async (outcome) => {
    const root = await tempRoot();
    const published: string[] = [];
    let terminated = 0;
    try {
      const fiber = Effect.runFork(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: join(root, "shim"),
          privateFileAccess: {
            enforce: async (path) => {
              await chmod(path, 0o600);
              if (path.includes("worker.json.tmp-")) {
                if (outcome === "failure") throw new Error("record write denied");
                fiber.interruptUnsafe();
              }
            },
            verify: async () => undefined,
          },
          publish: (session) =>
            Effect.sync(() => {
              published.push(session.sessionId);
            }),
          spawnWorker: (spec) => ({
            pid: 876543,
            logPath: join(root, "worker.log"),
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => ({
              _tag: "ready",
              appId: app.id,
              sessionId: "session",
              token: "token",
              controlToken: "control",
              socketPath: join(root, "host-proxy.sock"),
              shimPath: join(root, "lando"),
              transport: "unix-socket",
            }),
            terminate: async () => {
              terminated++;
            },
          }),
        }),
      );
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(exit._tag).toBe("Failure");
      expect(Exit.hasInterrupts(exit)).toBe(outcome === "interruption");
      expect(terminated).toBe(outcome === "interruption" ? 0 : 1);
      expect(published).toEqual(outcome === "interruption" ? ["session"] : []);
      expect(await Effect.runPromise(readWorkerRecord(app, { userDataRoot: root }))).toEqual(
        outcome === "interruption"
          ? expect.objectContaining({ sessionId: "session", pid: 876543 })
          : undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
    providerId: "lando",
    sessionId: "session-1",
    token: "secret-token",
    configDigest: "previous-config",
  };
};

type TestControlRecord = HostProxyControlRecord & {
  readonly socketPath: string;
  readonly shimPath: string;
  readonly startedAt: string;
  readonly configDigest?: string;
};

const legacyWorkerRecord = (root: string): TestControlRecord => {
  const runDir = join(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot, sanitizeAppName(app.id));
  return {
    appId: app.id,
    transport: "unix-socket",
    socketPath: join(runDir, "host-proxy.sock"),
    shimPath: join(runDir, "lando"),
    protocolVersion: 1,
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
  readonly requests: () => number;
}> => {
  let shutdowns = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
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
          configDigest: record.configDigest,
          transport: record.transport,
          protocolVersion: record.protocolVersion,
          pid: record.pid,
          bridge: "none",
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
  return { record, server, shutdowns: () => shutdowns, requests: () => requests };
};

const listenControlServer = async (root: string) => listenControlServerForRecord(workerRecord(root));

describe("detached host-proxy worker manager", () => {
  test.each([0, -1, 1.5])("rejects malformed worker pid %s", async (pid) => {
    // Given untrusted persisted control state.
    const root = await tempRoot();
    const path = join(root, "worker.json");
    try {
      await writeFile(path, JSON.stringify({ ...workerRecord(root), pid }));
      // When decoded, then it cannot authorize process control.
      expect((await Effect.runPromise(readWorkerRecordStateAt(path)))._tag).toBe("malformed");
      expect(
        Schema.is(HostProxyWorkerIdentity)({
          appId: "demo",
          sessionId: "session",
          transport: "unix-socket",
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          pid,
          bridge: "none",
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["terminate", "root", "replace"] as const)(
    "%s never contacts an untrusted record",
    async (operation) => {
      // Given a live control server referenced by a world-readable record.
      const root = await tempRoot();
      const control = await listenControlServerForRecord(workerRecord(root, { pid: process.pid }));
      const signals: number[] = [];
      try {
        await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, control.record));
        await chmod(workerStatePath(app, { userDataRoot: root }), 0o644);
        // When a cleanup or replacement is requested.
        if (operation === "root")
          await Effect.runPromise(
            terminateOwnedHostProxyWorkersInRootWithPrivateFileAccess(root, {
              privateFileAccess: ownerOnlyFileAccess,
              terminateProcess: async (pid) => {
                signals.push(pid);
              },
            }),
          );
        else if (operation === "terminate")
          await Effect.runPromise(
            terminateOwnedHostProxyWorker(app, {
              paths: { userDataRoot: root },
              terminateProcess: async (pid) => {
                signals.push(pid);
              },
            }),
          );
        else {
          const session = await Effect.runPromise(
            startDetachedHostProxyWorker({
              app,
              plan,
              paths: { userDataRoot: root },
              shimArtifactPath: await fakeShim(root),
              terminateProcess: async (pid) => {
                signals.push(pid);
              },
            }),
          );
          await session.close();
        }
        // Then the untrusted record grants neither network nor signal authority.
        expect(control.requests()).toBe(0);
        expect(signals).toEqual([]);
      } finally {
        control.server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test("persists private reusable session credentials in worker.json", async () => {
    const root = await tempRoot();
    const writes: string[] = [];
    const database = servicePlan("database", "/app", false);
    const appserver = servicePlan("appserver", "/app");
    const worker = servicePlan("worker", "/app");
    const eligiblePlan: AppPlan = {
      ...plan,
      services: {
        [database.name]: database,
        [appserver.name]: appserver,
        [worker.name]: worker,
      },
    };
    try {
      const session = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan: eligiblePlan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
          spawnWorker: (spec) => ({
            pid: 12345,
            logPath: join(root, "worker.log"),
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
              containerUrl: "http://host.containers.internal:32123",
              shimPath: join(dirname(workerStatePath(app, { userDataRoot: root })), "lando"),
              transport: "unix-socket" as const,
            }),
            terminate: async () => undefined,
          }),
        }),
      );

      const record = await readFile(workerStatePath(app, { userDataRoot: root }), "utf8");
      expect((await Bun.file(workerStatePath(app, { userDataRoot: root })).stat()).mode & 0o077).toBe(0);

      expect(session.token).toBe("secret-token");
      expect(session.controlToken).toBe("control-token");
      expect(writes[0]).toContain('"id":"demo"');
      expect(writes.join("\n")).not.toContain("secret-token");
      expect(record).toContain('"controlToken": "control-token"');
      expect(JSON.parse(record).protocolVersion).toBe(HOST_PROXY_WORKER_PROTOCOL_VERSION);
      expect(record).toContain('"providerId": "lando"');
      expect(record).toContain('"containerUrl": "http://host.containers.internal:32123"');
      expect(record).toContain('"probeServices": [\n    "appserver",\n    "worker"\n  ]');
      expect(JSON.parse(record)).toMatchObject({ token: session.token, sessionId: session.sessionId });
      expect(hostProxyWorkerArgv({ ...workerEntry, appId: "demo" })).toEqual(
        expect.arrayContaining(["--app-id", "demo"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("classifies absent, current, legacy, and malformed worker state", async () => {
    // Given
    const root = await tempRoot();
    const currentPath = workerStatePath(app, { userDataRoot: root });
    const legacyPath = join(root, "legacy-worker.json");
    const malformedPath = join(root, "malformed-worker.json");
    try {
      await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, workerRecord(root)));
      const currentRecord = workerRecord(root);
      await writeFile(
        legacyPath,
        `${JSON.stringify({
          appId: currentRecord.appId,
          transport: currentRecord.transport,
          socketPath: currentRecord.socketPath,
          shimPath: currentRecord.shimPath,
          protocolVersion: currentRecord.protocolVersion,
          startedAt: currentRecord.startedAt,
          pid: currentRecord.pid,
          controlToken: currentRecord.controlToken,
        })}\n`,
      );
      await writeFile(malformedPath, "{not-json\n");

      // When
      const states = await Promise.all(
        [join(root, "absent-worker.json"), currentPath, legacyPath, malformedPath].map((path) =>
          Effect.runPromise(readWorkerRecordStateAt(path)),
        ),
      );

      // Then
      expect(states.map((state) => state._tag)).toEqual(["absent", "current", "legacy", "malformed"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("classifies a partial record with control credentials as terminable legacy state", async () => {
    // Given
    const root = await tempRoot();
    const path = join(root, "invalid-current-worker.json");
    const record = legacyWorkerRecord(root);
    try {
      await writeFile(path, `${JSON.stringify({ ...record, appRoot: 42, providerId: "lando" })}\n`);

      // When
      const state = await Effect.runPromise(readWorkerRecordStateAt(path));

      // Then
      expect(state._tag).toBe("legacy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("spawns compiled host-proxy workers through the compiled executable", () => {
    const argv = hostProxyWorkerArgv({
      entryPath: "/$bunfs/root/core/bin/lando.ts",
      execPath: "/usr/local/bin/lando",
      bunSourceEntryPath: "/repo/core/bin/lando.ts",
      appId: "demo",
    });

    expect(argv).toEqual(["/usr/local/bin/lando", "__internal:host-proxy-worker", "--app-id", "demo"]);
  });

  test("spawns Bun source workers through the explicitly supplied core entry", async () => {
    // Given
    const { bunSourceEntryPath } = hostProxyWorkerEntry();

    // When
    const argv = hostProxyWorkerArgv({
      entryPath: "/repo/scripts/launcher.ts",
      execPath: "/usr/local/bin/bun",
      bunSourceEntryPath,
      appId: "demo",
    });

    // Then
    expect(await Bun.file(bunSourceEntryPath).exists()).toBe(true);
    expect(argv).toEqual([
      "/usr/local/bin/bun",
      bunSourceEntryPath,
      "__internal:host-proxy-worker",
      "--app-id",
      "demo",
    ]);
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
          logPath: join(root, "worker.log"),
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

      const worker = await defaultSpawnWorker({
        argv: [process.execPath, scriptPath],
        privateFileAccess: ownerOnlyFileAccess,
      });
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

  test("identity without root and provider can authorize shutdown but not reuse", async () => {
    const root = await tempRoot();
    const { record, server } = await listenControlServer(root);
    try {
      expect(
        await Effect.runPromise(probeWorkerWithPrivateFileAccess(record, { requireSessionIdentity: true })),
      ).toBe("dead");
      expect(await Effect.runPromise(probeWorker(record))).toBe("live");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["alive", "dead", undefined] as const)(
    "shuts down a bridged Windows worker with bridge=%s through its TCP control listener",
    async (bridge) => {
      const root = await tempRoot();
      const base = workerRecord(root);
      let shutdowns = 0;
      const server = createServer((request, response) => {
        if (request.headers["x-lando-host-proxy-control"] !== base.controlToken) {
          response.writeHead(401).end();
          return;
        }
        const pathname = new URL(request.url ?? "", "http://control.invalid").pathname;
        if (pathname === "/_lando/host-proxy/identify") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              appId: base.appId,
              sessionId: "session-1",
              configDigest: base.configDigest,
              transport: "tcp-host-gateway",
              protocolVersion: base.protocolVersion,
              pid: base.pid,
              ...(bridge === undefined ? {} : { bridge }),
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
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(0, "127.0.0.1", resolveListen);
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Expected TCP control port.");
        const bridgedRecord = { ...base, url: `http://127.0.0.1:${address.port}` };
        await Effect.runPromise(writeWorkerRecord(app, { userDataRoot: root }, bridgedRecord));
        expect(await Effect.runPromise(probeWorker(bridgedRecord))).toBe(
          bridge === "alive" ? "live" : "dead",
        );
        expect(
          await Effect.runPromise(terminateOwnedHostProxyWorker(app, { paths: { userDataRoot: root } })),
        ).toBe("terminated");
        expect(shutdowns).toBe(1);
        expect(await Bun.file(workerStatePath(app, { userDataRoot: root })).exists()).toBe(false);
      } finally {
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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

  test("replaces a config-mismatched live worker before spawning the next worker", async () => {
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
            logPath: join(root, "worker.log"),
            argv: hostProxyWorkerArgv({ ...workerEntry, appId: "demo" }),
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
    const readingReady = Promise.withResolvers<void>();
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
            logPath: join(root, "worker.log"),
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: () => {
              readingReady.resolve();
              return new Promise(() => undefined);
            },
            terminate: async () => {
              terminated += 1;
            },
          }),
        }),
      );
      await readingReady.promise;
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
            logPath: join(root, "worker.log"),
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

      expect(pidIsAlive(record.pid)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replacing a config-mismatched live real worker exits the old worker pid", async () => {
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

      await writeFile(join(root, "replacement-shim"), "#!/usr/bin/env sh\nexit 0\n");
      const second = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: join(root, "replacement-shim"),
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

  test("two real ensures reuse the worker pid and all credentials and register secrets", async () => {
    // Given a live app-wide worker.
    const root = await tempRoot();
    const registered: string[] = [];
    const service = makeRedactionService();
    const redactor = RedactionService.of({
      ...service,
      registerValues: (values) =>
        service.registerValues(values).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registered.push(...values);
            }),
          ),
        ),
    });
    const options = { app, plan, paths: { userDataRoot: root }, shimArtifactPath: await fakeShim(root) };
    const first = await Effect.runPromise(
      startDetachedHostProxyWorker(options).pipe(Effect.provideService(RedactionService, redactor)),
    );
    try {
      const before = await Effect.runPromise(readWorkerRecord(app, options.paths));
      expect(registered).toEqual([first.sessionId, first.token, first.controlToken]);
      registered.length = 0;
      // When the unchanged configuration is ensured again.
      const second = await Effect.runPromise(
        startDetachedHostProxyWorker(options).pipe(Effect.provideService(RedactionService, redactor)),
      );
      const after = await Effect.runPromise(readWorkerRecord(app, options.paths));
      // Then no credentials or process change, including the control credential.
      expect(after?.pid).toBe(before?.pid);
      expect([second.sessionId, second.token, second.controlToken]).toEqual([
        first.sessionId,
        first.token,
        first.controlToken,
      ]);
      expect(registered).toEqual(expect.arrayContaining([first.sessionId, first.token, first.controlToken]));
      const output = await Effect.runPromise(
        encodeCommandResult({
          command: "app:open",
          resultSchema: Schema.Struct({
            sessionId: Schema.String,
            token: Schema.String,
            controlToken: Schema.String,
          }),
          outcome: {
            _tag: "success",
            value: { sessionId: first.sessionId, token: first.token, controlToken: first.controlToken },
          },
          redactor: await Effect.runPromise(redactor.forProfile("secrets")),
        }),
      );
      expect(JSON.parse(output).ok).toBe(true);
      expect(output).not.toContain(first.token);
      expect(output).not.toContain(first.sessionId);
      expect(output).not.toContain(first.controlToken);
      await second.close();
      expect(existsSync(dirname(workerStatePath(app, options.paths)))).toBe(false);
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("adopt reuses a healthy differently configured worker and close leaves it alive", async () => {
    const root = await tempRoot();
    const options = { app, plan, paths: { userDataRoot: root }, shimArtifactPath: await fakeShim(root) };
    const first = await Effect.runPromise(startDetachedHostProxyWorker(options));
    try {
      const before = await Effect.runPromise(readWorkerRecord(app, options.paths));
      const adopted = await Effect.runPromise(
        startDetachedHostProxyWorker({
          ...options,
          plan: { ...plan, name: "new-config" },
          reusePolicy: "adopt",
        }),
      );
      await adopted.close();
      expect(adopted.token).toBe(first.token);
      expect(adopted.sessionId).toBe(first.sessionId);
      expect(before !== undefined && pidIsAlive(before.pid)).toBe(true);
      expect(await Effect.runPromise(readWorkerRecord(app, options.paths))).toEqual(before);
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["exact", "adopt"] as const)(
    "%s refreshes routes and cwd mounts in the same real worker",
    async (reusePolicy) => {
      const root = await tempRoot();
      const localApp = { ...app, root: AbsolutePath.make(join(root, "app")) };
      const localPlan = { ...plan, root: localApp.root };
      await mkdir(join(localApp.root, "web"), { recursive: true });
      await writeFile(
        join(localApp.root, ".lando.yml"),
        "name: demo\nservices:\n  appserver:\n    type: nginx\nproxy:\n  appserver:\n    - changed.lndo.site\n",
      );
      const eventPath = join(root, "requests.jsonl");
      const options = {
        app: localApp,
        plan: localPlan,
        paths: { userDataRoot: root },
        shimArtifactPath: await fakeShim(root),
        spawnWorker: async (spec: Parameters<typeof defaultSpawnWorker>[0]) => {
          const worker = await defaultSpawnWorker({
            ...spec,
            argv: [
              process.execPath,
              fileURLToPath(new URL("./call-test-entry.ts", import.meta.url)),
              ...spec.argv.slice(2),
              "--test-events",
              eventPath,
            ],
          });
          spawnedPids.add(worker.pid);
          return worker;
        },
      };
      const first = await Effect.runPromise(startDetachedHostProxyWorker(options));
      try {
        const before = await Effect.runPromise(readWorkerRecord(localApp, options.paths));
        const service: ServicePlan = {
          ...servicePlan("appserver", "/changed"),
          mounts: servicePlan("appserver", "/changed").mounts.map((mount) => ({
            ...mount,
            source: localApp.root,
          })),
          endpoints: [
            { _tag: "internal", protocol: "http", port: PortNumber.make(80), name: "http", primary: true },
          ],
        };
        const updated: AppPlan = {
          ...localPlan,
          metadata: { ...plan.metadata, resolvedAt: DateTime.makeUnsafe("2026-02-01T00:00:00Z") },
          services: { [service.name]: service },
          routes: [
            {
              service: service.name,
              endpoint: "http",
              hostname: "changed.lndo.site",
              scheme: "http",
              pathPrefix: "/",
              priority: 2,
              backend: { service: service.name, protocol: "http", port: PortNumber.make(80) },
            },
          ],
        };
        const second = await Effect.runPromise(
          startDetachedHostProxyWorker({ ...options, plan: updated, reusePolicy }),
        );
        const after = await Effect.runPromise(readWorkerRecord(localApp, options.paths));
        const wire = Schema.encodeUnknownSync(AppPlan)(updated);
        for (const invalid of [{}, { ...wire, root: "/foreign" }, { ...wire, provider: "docker" }]) {
          const status = await new Promise<number | undefined>((resolve, reject) => {
            const request = httpRequest(
              {
                socketPath: second.socketPath,
                method: "POST",
                path: "/_lando/host-proxy/configure",
                headers: {
                  "x-lando-host-proxy-control": second.controlToken,
                  authorization: `Bearer ${second.token}`,
                  "x-lando-host-proxy-session": second.sessionId,
                  "x-lando-host-proxy-app": second.appId,
                },
              },
              (response) => {
                response.resume();
                response.on("end", () => resolve(response.statusCode));
              },
            );
            request.on("error", reject);
            request.end(JSON.stringify(invalid));
          });
          expect(status).toBe(503);
        }
        const result = await Effect.runPromise(
          sendHostProxyRunLando(second, {
            argv: ["app:open", "--print", "--format=json"],
            cwd: "/changed/web",
            tty: false,
          }),
        );
        expect(after?.pid).toBe(before?.pid);
        expect([second.sessionId, second.token, second.controlToken]).toEqual([
          first.sessionId,
          first.token,
          first.controlToken,
        ]);
        const envelope = JSON.parse(result.stdout);
        expect(envelope).toMatchObject({ ok: true });
        expect(envelope.result).toMatchObject({
          targets: [expect.objectContaining({ url: expect.stringContaining("changed.lndo.site") })],
        });
        expect(
          (await readFile(eventPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toContainEqual(
          expect.objectContaining({
            _tag: "pre-host-proxy-call",
            request: expect.objectContaining({ cwd: join(localApp.root, "web") }),
          }),
        );
      } finally {
        await first.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("disk config changes reach fresh children without worker restart", async () => {
    const root = await tempRoot();
    const localApp = { ...app, root: AbsolutePath.make(join(root, "app")) };
    await mkdir(localApp.root);
    await writeFile(
      join(localApp.root, ".lando.yml"),
      "name: demo\nservices:\n  appserver:\n    type: nginx\nproxy:\n  appserver:\n    - demo.lndo.site\n",
    );
    const eventPath = join(root, "generations.jsonl");
    const service: ServicePlan = {
      ...servicePlan("appserver", "/app"),
      endpoints: [
        {
          _tag: "internal" as const,
          protocol: "http" as const,
          port: PortNumber.make(80),
          name: "http",
          primary: true,
        },
      ],
    };
    const routed: AppPlan = {
      ...plan,
      root: localApp.root,
      services: { [service.name]: service },
      routes: [
        {
          service: service.name,
          endpoint: "http",
          hostname: "demo.lndo.site",
          scheme: "http",
          pathPrefix: "/",
          priority: 2,
          backend: { service: service.name, protocol: "http", port: PortNumber.make(80) },
        },
      ],
    };
    const paths = {
      ...makeLandoPaths({ userDataRoot: root }).roots,
      userConfRoot: join(root, "conf"),
      userCacheRoot: join(root, "cache"),
      systemPluginRoot: join(root, "plugins"),
      platform: "linux",
    };
    const options = {
      app: localApp,
      plan: routed,
      paths,
      shimArtifactPath: await fakeShim(root),
      spawnWorker: async (spec: Parameters<typeof defaultSpawnWorker>[0]) => {
        const worker = await defaultSpawnWorker({
          ...spec,
          argv: [
            process.execPath,
            fileURLToPath(new URL("./call-test-entry.ts", import.meta.url)),
            ...spec.argv.slice(2),
            "--test-events",
            eventPath,
          ],
        });
        spawnedPids.add(worker.pid);
        return worker;
      },
    };
    const ensure = async (port: number) => {
      await mkdir(paths.userConfRoot, { recursive: true });
      await writeFile(join(paths.userConfRoot, "config.yml"), `router:\n  httpPort: ${port}\n`);
      return Effect.runPromise(startDetachedHostProxyWorker({ ...options, reusePolicy: "exact" }));
    };
    const first = await ensure(19001);
    const request = () =>
      Effect.runPromise(
        sendHostProxyRunLando(first, {
          argv: ["app:open", "--print", "--format=json"],
          cwd: "/app",
          tty: false,
        }),
      );
    const observed = async () =>
      (await readFile(eventPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    try {
      const before = await Effect.runPromise(readWorkerRecord(localApp, paths));
      expect(JSON.parse((await request()).stdout).result).toMatchObject({
        targets: [expect.objectContaining({ url: "https://demo.lndo.site:19001" })],
      });
      const same = await ensure(19001);
      const refreshed = await ensure(19002);
      expect(JSON.parse((await request()).stdout).result).toMatchObject({
        targets: [expect.objectContaining({ url: "https://demo.lndo.site:19002" })],
      });
      for (const session of [same, refreshed])
        expect([session.sessionId, session.token, session.controlToken, session.socketPath]).toEqual([
          first.sessionId,
          first.token,
          first.controlToken,
          first.socketPath,
        ]);
      expect((await Effect.runPromise(readWorkerRecord(localApp, paths)))?.pid).toBe(before?.pid);
      expect((await observed()).filter((entry) => entry.configPort !== undefined)).toEqual(
        [19001, 19002].map((configPort) => ({
          configPort,
          roots: {
            userConfRoot: paths.userConfRoot,
            userCacheRoot: paths.userCacheRoot,
            userDataRoot: paths.userDataRoot,
            systemPluginRoot: paths.systemPluginRoot,
          },
          platform: "linux",
        })),
      );
      await writeFile(join(paths.userConfRoot, "config.yml"), "router:\n  httpPort: invalid\n");
      expect((await request()).exitCode).not.toBe(0);
      await ensure(19002);
      expect(JSON.parse((await request()).stdout).result).toMatchObject({
        targets: [expect.objectContaining({ url: "https://demo.lndo.site:19002" })],
      });
      await writeFile(join(paths.userConfRoot, "config.yml"), "router:\n  httpPort: 19004\n");
      const adopted = await Effect.runPromise(
        startDetachedHostProxyWorker({
          ...options,
          paths: { ...paths, userCacheRoot: join(root, "foreign-cache") },
          reusePolicy: "adopt",
        }),
      );
      await adopted.close();
      expect(JSON.parse((await request()).stdout).result).toMatchObject({
        targets: [expect.objectContaining({ url: "https://demo.lndo.site:19004" })],
      });
      expect(pidIsAlive(before?.pid ?? 0)).toBe(true);
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("worker payload config digest is deterministic and independent of routes", async () => {
    const root = await tempRoot();
    const digests: unknown[] = [];
    const options = {
      app,
      plan,
      paths: { userDataRoot: root },
      shimArtifactPath: await fakeShim(root),
      spawnWorker: () => ({
        pid: 12345,
        logPath: join(root, "worker.log"),
        argv: [],
        writeStdin: async (value: string) => {
          digests.push(JSON.parse(value).configDigest);
        },
        readReady: async () => ({
          _tag: "ready" as const,
          appId: app.id,
          sessionId: "session-1",
          token: "bearer",
          controlToken: "control",
          shimPath: join(root, "shim"),
        }),
        terminate: async () => undefined,
      }),
    };
    try {
      await Effect.runPromise(startDetachedHostProxyWorker(options));
      await Effect.runPromise(startDetachedHostProxyWorker(options));
      await Effect.runPromise(
        startDetachedHostProxyWorker({
          ...options,
          plan: {
            ...plan,
            routes: [
              {
                service: ServiceName.make("appserver"),
                endpoint: "http",
                hostname: "demo.lndo.site",
                scheme: "http",
                pathPrefix: "/",
                priority: 2,
                backend: {
                  service: ServiceName.make("appserver"),
                  protocol: "http",
                  port: PortNumber.make(80),
                },
              },
            ],
          },
        }),
      );
      expect(digests[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(digests[1]).toBe(digests[0]);
      expect(digests[2]).toBe(digests[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "dead",
    "foreign-app",
    "foreign-root",
    "config",
    "provider",
    "v1",
    "non-private",
    "verify-fails",
    "corrupt",
    "bearer",
    "session",
    "identity-digest",
    "shim",
    "socket-file",
    "run-directory-public",
  ] as const)(
    "replaces a rejected %s real worker record without signalling foreign workers",
    async (rejection) => {
      // Given a healthy worker whose persisted ownership or reuse proof is rejected.
      const root = await tempRoot();
      const options = { app, plan, paths: { userDataRoot: root }, shimArtifactPath: await fakeShim(root) };
      const first = await Effect.runPromise(startDetachedHostProxyWorker(options));
      const path = workerStatePath(app, options.paths);
      const before = await Effect.runPromise(readWorkerRecord(app, options.paths));
      if (before === undefined) throw new Error("Missing initial worker record");
      let second: typeof first | undefined;
      try {
        const wire = JSON.parse(await readFile(path, "utf8"));
        switch (rejection) {
          case "dead":
            process.kill(before.pid, "SIGKILL");
            await waitForPidExit(before.pid);
            break;
          case "foreign-app":
            wire.appId = "foreign";
            break;
          case "foreign-root":
            wire.appRoot = "/foreign";
            break;
          case "config":
            wire.configDigest = "mismatch";
            break;
          case "provider":
            wire.providerId = "docker";
            break;
          case "v1":
            wire.protocolVersion = 1;
            wire.token = undefined;
            wire.sessionId = undefined;
            wire.configDigest = undefined;
            break;
          case "non-private":
            await chmod(path, 0o644);
            break;
          case "verify-fails":
            break;
          case "corrupt":
            break;
          case "bearer":
            wire.token = "wrong-bearer";
            break;
          case "session":
            wire.sessionId = "wrong-session";
            break;
          case "identity-digest":
            wire.configDigest = "wrong-identity-config";
            break;
          case "shim":
            await rm(before.shimPath);
            break;
          case "socket-file":
            if (before.socketPath === undefined) throw new Error("Expected socket");
            await rm(before.socketPath);
            await writeFile(before.socketPath, "not a socket", { mode: 0o600 });
            break;
          case "run-directory-public":
            if (before.socketPath === undefined) throw new Error("Expected socket");
            await chmod(dirname(before.socketPath), 0o755);
            break;
        }
        if (rejection !== "dead")
          await writeFile(path, rejection === "corrupt" ? "{broken" : JSON.stringify(wire));
        // When ensuring again.
        second = await Effect.runPromise(
          startDetachedHostProxyWorker({
            ...options,
            ...(rejection === "identity-digest" ? { reusePolicy: "adopt" as const } : {}),
            ...(rejection === "verify-fails"
              ? {
                  privateFileAccess: {
                    ...ownerOnlyFileAccess,
                    verify: async (candidate) => {
                      if (candidate === path) throw new Error("private access rejected");
                      await ownerOnlyFileAccess.verify(candidate);
                    },
                  },
                }
              : {}),
          }),
        );
        const after = await Effect.runPromise(readWorkerRecord(app, options.paths));
        // Then replacement gets a new session; foreign processes are untouched.
        expect(after?.pid).not.toBe(before.pid);
        expect(second.sessionId).not.toBe(first.sessionId);
        if (rejection === "foreign-app" || rejection === "foreign-root" || rejection === "corrupt")
          expect(pidIsAlive(before.pid)).toBe(true);
        if (
          rejection === "config" ||
          rejection === "provider" ||
          rejection === "bearer" ||
          rejection === "session"
        )
          expect(pidIsAlive(before.pid)).toBe(false);
      } finally {
        await second?.close();
        await first.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("shuts down a live protocol-v1 control-only record before replacing it", async () => {
    const root = await tempRoot();
    const control = await listenControlServerForRecord({ ...workerRecord(root), protocolVersion: 1 });
    try {
      await writeFile(
        workerStatePath(app, { userDataRoot: root }),
        JSON.stringify({
          appId: app.id,
          appRoot: app.root,
          transport: control.record.transport,
          protocolVersion: 1,
          socketPath: control.record.socketPath,
          pid: control.record.pid,
          controlToken: control.record.controlToken,
        }),
        { mode: 0o600 },
      );
      const session = await Effect.runPromise(
        startDetachedHostProxyWorker({
          app,
          plan,
          paths: { userDataRoot: root },
          shimArtifactPath: await fakeShim(root),
        }),
      );
      expect(control.shutdowns()).toBe(1);
      expect((await Effect.runPromise(readWorkerRecord(app, { userDataRoot: root })))?.protocolVersion).toBe(
        HOST_PROXY_WORKER_PROTOCOL_VERSION,
      );
      await session.close();
    } finally {
      control.server.close();
      await rm(root, { recursive: true, force: true });
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
        { mode: 0o600 },
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
            logPath: join(root, "worker.log"),
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
