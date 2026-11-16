import { join } from "node:path";
import { AbsolutePath, type AgentSocketKind, type AppRef } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import type { HostProxyWorkerRecord } from "../../src/subsystems/host-proxy/worker-records.ts";
import { workerStatePath, writeWorkerRecord } from "../../src/subsystems/host-proxy/worker-state-file.ts";
import { sshAgentSessionPaths } from "../../src/subsystems/ssh-agent/session.ts";
import { writeAgentRelayWorkerRecord } from "../../src/subsystems/ssh-agent/worker-state.ts";
import type { makeHarness } from "./start-progress-topology-support.ts";

type Harness = ReturnType<typeof makeHarness>;

/** A pid that no live process owns, so cleanup reaps the record without signalling anything. */
const deadPid = async (): Promise<number> => {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  await child.exited;
  return child.pid;
};

const harnessPaths = (harness: Harness) =>
  Effect.runPromise(Effect.service(PathsService).pipe(Effect.provide(harness.layer)));

const harnessPrivateFileAccess = (harness: Harness) =>
  Effect.runPromise(Effect.service(PrivateFileAccessService).pipe(Effect.provide(harness.layer)));

export const writeHostProxyWorker = async (harness: Harness, app: AppRef) => {
  const paths = await harnessPaths(harness);
  const roots = { ...paths.roots, platform: paths.platform };
  const runDir = paths.hostProxyRunDir(app.id, app.root);
  const record: HostProxyWorkerRecord = {
    appId: app.id,
    transport: "unix-socket",
    socketPath: join(runDir, "absent.sock"),
    protocolVersion: 3,
    pid: await deadPid(),
    controlToken: "control-token",
    shimPath: join(runDir, "shim"),
    startedAt: "2026-01-01T00:00:00.000Z",
    appRoot: app.root,
    providerId: "lando",
    sessionId: "host-proxy-session",
    token: "token",
    configDigest: "config-digest",
  };
  await Effect.runPromise(writeWorkerRecord(app, roots, record, await harnessPrivateFileAccess(harness)));
  return workerStatePath(app, roots);
};

export const writeAgentRelayWorker = async (
  harness: Harness,
  app: Pick<AppRef, "id" | "root">,
  kind: AgentSocketKind,
) => {
  const paths = await harnessPaths(harness);
  const roots = { ...paths.roots, platform: paths.platform };
  const stateDir = paths.agentRelayRunDir(kind, app.id, app.root);
  await Effect.runPromise(
    writeAgentRelayWorkerRecord(
      app,
      { paths: roots, kind, privateFileAccess: await harnessPrivateFileAccess(harness) },
      {
        appId: app.id,
        appRoot: app.root,
        sessionId: `${kind}-session`,
        kind,
        socketName: kind === "ssh" ? "agent.sock" : "S.gpg-agent",
        protocolVersion: 2,
        configDigest: "config-digest",
        controlToken: "control-token",
        controlPort: 12345,
        pid: await deadPid(),
        mount: { _tag: "bind-directory", directory: AbsolutePath.make(join(stateDir, "socket")) },
      },
    ),
  );
  return sshAgentSessionPaths(app, roots, kind).recordPath;
};
