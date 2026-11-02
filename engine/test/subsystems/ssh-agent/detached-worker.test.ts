import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Fiber, Schema } from "effect";
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
    protocolVersion: 2,
    configDigest: "pending",
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
            logPath: join(root, "worker.log"),
            argv,
            writeStdin: async (value) => {
              payload = value;
            },
            readReady: async () => ({
              ...ready,
              configDigest: Schema.decodeUnknownSync(AgentRelayWorkerInput)(JSON.parse(payload)).configDigest,
            }),
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
      Effect.result(
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
            logPath: join(root, "worker.log"),
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
                protocolVersion: 2,
                configDigest: "mismatched",
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
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SshAgentTransportError", stage: "worker" },
    });
    expect(terminated).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a published worker owned when cancellation lands at publication", async () => {
  // Given a worker whose validated session is published while the start is being cancelled.
  const root = await mkdtemp(join(tmpdir(), "agent-detached-publish-"));
  const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
  const published: Array<string> = [];
  let payload = "";
  let terminated = 0;
  try {
    const fiber = Effect.runFork(
      startDetachedAgentRelayWorker({
        app,
        plan: { id: AppId.make(app.id), provider: ProviderId.make("lando") },
        paths: { userDataRoot: root },
        kind: "ssh",
        socketName: "agent.sock",
        delivery: "bind-directory",
        upstream: { _tag: "unix", path: "/agent" },
        privateFileAccess: { enforce: async (path) => chmod(path, 0o600), verify: async () => undefined },
        publish: (session) =>
          Effect.sync(() => {
            published.push(session.sessionId);
            fiber.interruptUnsafe();
          }),
        spawnWorker: (spec) => ({
          pid: 876543,
          logPath: join(root, "worker.log"),
          argv: spec.argv,
          writeStdin: async (value) => {
            payload = value;
          },
          readReady: async () => ({
            _tag: "ready",
            appId: app.id,
            appRoot: app.root,
            sessionId: "session",
            kind: "ssh",
            protocolVersion: 2,
            configDigest: Schema.decodeUnknownSync(AgentRelayWorkerInput)(JSON.parse(payload)).configDigest,
            pid: 876543,
            controlToken: "control",
            controlPort: 12345,
            socketName: "agent.sock",
            mount: { _tag: "bind-directory", directory: AbsolutePath.make(join(root, "socket")) },
          }),
          terminate: async () => {
            terminated++;
          },
        }),
      }),
    );
    // When
    const exit = await Effect.runPromise(Fiber.await(fiber));
    // Then the interrupted start hands the recorded worker to its owner instead of terminating it.
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(published).toEqual(["session"]);
    expect(terminated).toBe(0);
    expect(
      await Effect.runPromise(
        readAgentRelayWorkerRecord(app, {
          paths: { userDataRoot: root },
          kind: "ssh",
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        }),
      ),
    ).toMatchObject({
      sessionId: "session",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["interruption", "failure"] as const)(
  "ownership record write %s preserves worker ownership semantics",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "agent-detached-record-"));
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
    const published: string[] = [];
    let payload = "";
    let terminated = 0;
    try {
      const fiber = Effect.runFork(
        startDetachedAgentRelayWorker({
          app,
          plan: { id: AppId.make(app.id), provider: ProviderId.make("lando") },
          paths: { userDataRoot: root },
          kind: "ssh",
          socketName: "agent.sock",
          delivery: "bind-directory",
          upstream: { _tag: "unix", path: "/agent" },
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
            writeStdin: async (value) => {
              payload = value;
            },
            readReady: async () => ({
              _tag: "ready",
              appId: app.id,
              appRoot: app.root,
              sessionId: "session",
              kind: "ssh",
              protocolVersion: 2,
              configDigest: Schema.decodeUnknownSync(AgentRelayWorkerInput)(JSON.parse(payload)).configDigest,
              pid: 876543,
              controlToken: "control",
              controlPort: 12345,
              socketName: "agent.sock",
              mount: { _tag: "bind-directory", directory: AbsolutePath.make(join(root, "socket")) },
            }),
            terminate: async () => {
              terminated++;
            },
          }),
        }),
      );
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.hasInterrupts(exit)).toBe(outcome === "interruption");
      expect(terminated).toBe(outcome === "interruption" ? 0 : 1);
      expect(published).toEqual(outcome === "interruption" ? ["session"] : []);
      expect(
        await Effect.runPromise(
          readAgentRelayWorkerRecord(app, {
            paths: { userDataRoot: root },
            kind: "ssh",
            privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
          }),
        ),
      ).toEqual(
        outcome === "interruption"
          ? expect.objectContaining({ sessionId: "session", pid: 876543 })
          : undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
