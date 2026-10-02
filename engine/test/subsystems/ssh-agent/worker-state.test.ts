import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";

test("replaceExisting terminates a live owned worker and removes a stale record", async () => {
  const { writeAgentRelayWorkerRecord, replaceExistingAgentRelayWorker, readAgentRelayWorkerRecord } =
    await import("../../../src/subsystems/ssh-agent/worker-state.ts");
  const { sshAgentSessionPaths } = await import("../../../src/subsystems/ssh-agent/session.ts");
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-state-"));
  const app = { id: "demo", root: AbsolutePath.make(root), kind: "user" as const };
  const privateFileAccess = {
    enforce: async (path: string) => chmod(path, 0o600),
    verify: async () => undefined,
  };
  const options = { paths: { userDataRoot: root }, kind: "ssh" as const, privateFileAccess };
  const record = {
    appId: app.id,
    appRoot: app.root,
    sessionId: "first",
    kind: "ssh" as const,
    socketName: "agent.sock",
    protocolVersion: 1 as const,
    controlToken: "token",
    controlPort: 12345,
    pid: 98765,
    mount: { _tag: "bind-directory" as const, directory: AbsolutePath.make(join(root, "socket")) },
  };
  const calls: number[] = [];
  let alive = true;
  try {
    await Effect.runPromise(writeAgentRelayWorkerRecord(app, options, record));
    // When
    await Effect.runPromise(
      replaceExistingAgentRelayWorker(app, {
        ...options,
        identify: async () => record,
        isAlive: () => alive,
        terminateProcess: async (pid) => {
          calls.push(pid);
          alive = false;
        },
      }),
    );
    // Then
    expect(calls).toEqual([98765]);
    expect(await Effect.runPromise(readAgentRelayWorkerRecord(app, options))).toBeUndefined();
    expect(
      await stat(sshAgentSessionPaths(app, options.paths, "ssh").socketDir).catch(() => undefined),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not signal a reused PID when worker identity differs", async () => {
  const { writeAgentRelayWorkerRecord, replaceExistingAgentRelayWorker } = await import(
    "../../../src/subsystems/ssh-agent/worker-state.ts"
  );
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-owner-"));
  const app = { id: "demo", root: AbsolutePath.make(root), kind: "user" as const };
  const options = {
    paths: { userDataRoot: root },
    kind: "ssh" as const,
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
  };
  const record = {
    appId: app.id,
    appRoot: app.root,
    sessionId: "first",
    kind: "ssh" as const,
    socketName: "agent.sock",
    protocolVersion: 1 as const,
    controlToken: "token",
    controlPort: 12345,
    pid: 98765,
    mount: { _tag: "volume" as const, volume: "agent" },
  };
  const calls: number[] = [];
  try {
    await Effect.runPromise(writeAgentRelayWorkerRecord(app, options, record));
    // When
    const outcome = await Effect.runPromise(
      Effect.either(
        replaceExistingAgentRelayWorker(app, {
          ...options,
          identify: async () => ({ ...record, sessionId: "another" }),
          isAlive: () => true,
          terminateProcess: async (pid) => {
            calls.push(pid);
          },
        }),
      ),
    );
    // Then
    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ _tag: "Left", left: { _tag: "SshAgentTransportError" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic detached worker decodes its own readiness schema", async () => {
  const { Schema } = await import("effect");
  const { spawnDetachedWorker } = await import("../../../src/subsystems/detached-worker/process.ts");
  // Given
  const root = await mkdtemp(join(tmpdir(), "generic-worker-"));
  const worker = spawnDetachedWorker(
    {
      argv: [process.execPath, "-e", 'process.stdout.write(JSON.stringify({answer:42}) + "\\n")'],
      logsDir: root,
    },
    { readySchema: Schema.Struct({ answer: Schema.Number }), logLabel: "agent-relay" },
  );
  try {
    // When
    const ready = await worker.readReady();
    // Then
    expect(ready).toEqual({ answer: 42 });
  } finally {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticates worker identity over a separate loopback control socket", async () => {
  const { createAgentRelayWorkerControl, identifyAgentRelayWorker } = await import(
    "../../../src/subsystems/ssh-agent/worker-protocol.ts"
  );
  // Given
  const identity = {
    appId: "demo",
    appRoot: AbsolutePath.make("/app/demo"),
    sessionId: "unique",
    kind: "ssh" as const,
    pid: process.pid,
    protocolVersion: 1 as const,
  };
  const control = await createAgentRelayWorkerControl(identity, "secret-control-token");
  const record = {
    ...identity,
    controlToken: "secret-control-token",
    controlPort: control.controlPort,
    socketName: "agent.sock",
    mount: { _tag: "volume" as const, volume: "relay" },
  };
  try {
    // When
    const result = await identifyAgentRelayWorker(record);
    // Then
    expect(result).toEqual(identity);
    await expect(identifyAgentRelayWorker({ ...record, controlToken: "incorrect" })).rejects.toMatchObject({
      _tag: "SshAgentTransportError",
    });
  } finally {
    await control.close();
  }
});

test("removes stale worker state without signaling a dead process", async () => {
  const { writeAgentRelayWorkerRecord, replaceExistingAgentRelayWorker, readAgentRelayWorkerRecord } =
    await import("../../../src/subsystems/ssh-agent/worker-state.ts");
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-dead-"));
  const app = { id: "demo", root: AbsolutePath.make(root), kind: "user" as const };
  const options = {
    paths: { userDataRoot: root },
    kind: "ssh" as const,
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
  };
  const record = {
    appId: app.id,
    appRoot: app.root,
    sessionId: "dead",
    kind: "ssh" as const,
    socketName: "agent.sock",
    protocolVersion: 1 as const,
    controlToken: "token",
    controlPort: 12345,
    pid: 98765,
    mount: { _tag: "volume" as const, volume: "agent" },
  };
  const calls: number[] = [];
  try {
    await Effect.runPromise(writeAgentRelayWorkerRecord(app, options, record));
    // When
    await Effect.runPromise(
      replaceExistingAgentRelayWorker(app, {
        ...options,
        isAlive: () => false,
        terminateProcess: async (pid) => {
          calls.push(pid);
        },
      }),
    );
    // Then
    expect(calls).toEqual([]);
    expect(await Effect.runPromise(readAgentRelayWorkerRecord(app, options))).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing a relay record keeps userDataRoot/run at mode 0700", async () => {
  const { writeAgentRelayWorkerRecord } = await import("../../../src/subsystems/ssh-agent/worker-state.ts");
  // Given a data root whose run directory is already traversable by other users.
  const root = await mkdtemp(join(tmpdir(), "agent-run-mode-"));
  const runRoot = join(root, "run");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(runRoot, { mode: 0o755 });
  await chmod(runRoot, 0o755);
  const app = { id: "demo", root: AbsolutePath.make(root), kind: "user" as const };
  const record = {
    appId: app.id,
    appRoot: app.root,
    sessionId: "first",
    kind: "ssh" as const,
    socketName: "agent.sock",
    protocolVersion: 1 as const,
    controlToken: "token",
    controlPort: 12345,
    pid: 98765,
    mount: { _tag: "bind-directory" as const, directory: AbsolutePath.make(join(root, "socket")) },
  };
  try {
    // When the worker record is written.
    await Effect.runPromise(
      writeAgentRelayWorkerRecord(
        app,
        {
          paths: { userDataRoot: root },
          kind: "ssh",
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        },
        record,
      ),
    );
    // Then other host users cannot traverse into the relay sockets.
    expect((await stat(runRoot)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
