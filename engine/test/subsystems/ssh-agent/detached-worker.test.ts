import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { startDetachedAgentRelayWorker } from "../../../src/subsystems/ssh-agent/detached-worker.ts";
import {
  AgentRelayWorkerInput,
  type AgentRelayWorkerReady,
} from "../../../src/subsystems/ssh-agent/worker-protocol.ts";
import { readAgentRelayWorkerRecord } from "../../../src/subsystems/ssh-agent/worker-state.ts";

test("writes the worker record from the ready frame", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-detached-"));
  const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
  const options = {
    app,
    plan: { id: AppId.make(app.id), provider: ProviderId.make("lando") },
    paths: { userDataRoot: root },
    kind: "ssh" as const,
    socketName: "agent.sock",
    delivery: "bind-directory" as const,
    upstream: { _tag: "unix" as const, path: "/upstream/agent" },
    privateFileAccess: { enforce: async (path: string) => chmod(path, 0o600), verify: async () => undefined },
  };
  const ready: AgentRelayWorkerReady = {
    _tag: "ready",
    appId: app.id,
    appRoot: app.root,
    sessionId: "session",
    kind: "ssh",
    protocolVersion: 1,
    pid: 876543,
    controlToken: "control",
    controlPort: 12345,
    socketName: "agent.sock",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make(join(root, "socket")) },
  };
  let payload = "";
  let argv: readonly string[] = [];
  let terminated = 0;
  try {
    // When
    const session = await Effect.runPromise(
      startDetachedAgentRelayWorker({
        ...options,
        spawnWorker: (spec) => {
          argv = spec.argv;
          return {
            pid: ready.pid,
            argv,
            writeStdin: async (value) => {
              payload = value;
            },
            readReady: async () => ready,
            terminate: async () => {
              terminated++;
            },
          };
        },
      }),
    );
    // Then
    expect(argv.slice(-3)).toEqual(["__internal:agent-relay-worker", "--app-id", app.id]);
    expect(Schema.decodeUnknownSync(AgentRelayWorkerInput)(JSON.parse(payload))).toMatchObject({
      app,
      plan: options.plan,
      upstream: options.upstream,
      delivery: "bind-directory",
      kind: "ssh",
      socketName: "agent.sock",
    });
    expect(await Effect.runPromise(readAgentRelayWorkerRecord(app, options))).toMatchObject({
      appId: app.id,
      sessionId: "session",
      pid: ready.pid,
      mount: ready.mount,
      controlToken: "control",
      controlPort: 12345,
    });
    expect(terminated).toBe(0);
    await session.close();
    await session.close();
    expect(terminated).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["readiness", "identity"] as const)("terminates a worker when %s fails", async (failure) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-detached-failure-"));
  const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
  let terminated = 0;
  try {
    // When
    const result = await Effect.runPromise(
      Effect.either(
        startDetachedAgentRelayWorker({
          app,
          plan: { id: AppId.make(app.id), provider: ProviderId.make("lando") },
          paths: { userDataRoot: root },
          kind: "ssh",
          socketName: "agent.sock",
          delivery: "bind-directory",
          upstream: { _tag: "unix", path: "/agent" },
          privateFileAccess: { enforce: async (path) => chmod(path, 0o600), verify: async () => undefined },
          spawnWorker: (spec) => ({
            pid: 876543,
            argv: spec.argv,
            writeStdin: async () => undefined,
            readReady: async () => {
              if (failure === "readiness") throw new Error("Worker exited");
              return {
                _tag: "ready",
                appId: "foreign",
                appRoot: app.root,
                sessionId: "session",
                kind: "ssh",
                protocolVersion: 1,
                pid: 876543,
                controlToken: "control",
                controlPort: 12345,
                socketName: "agent.sock",
                mount: { _tag: "volume", volume: "agent" },
              };
            },
            terminate: async () => {
              terminated++;
            },
          }),
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "SshAgentTransportError", stage: "worker" } });
    expect(terminated).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
