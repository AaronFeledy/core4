import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnDetachedWorker } from "@lando/engine/subsystems/detached-worker/process";
import { startDetachedAgentRelayWorker } from "@lando/engine/subsystems/ssh-agent/detached-worker";
import { type AgentRelaySession, sshAgentSessionPaths } from "@lando/engine/subsystems/ssh-agent/session";
import {
  AGENT_RELAY_WORKER_COMMAND,
  AgentRelayWorkerReady,
  identifyAgentRelayWorker,
} from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Option, Schema } from "effect";

test.each(["exit", "invalid-ready", "stdout-eof", "timeout"] as const)(
  "relay startup %s names its private log",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "relay-startup-failure-"));
    const app = { kind: "user" as const, id: "failure", root: AbsolutePath.make(root) };
    const source =
      failure === "exit"
        ? 'console.error("relay crashed"); process.exit(9);'
        : failure === "invalid-ready"
          ? 'console.log("ready-frame-credential"); setInterval(() => {}, 60000);'
          : failure === "stdout-eof"
            ? 'require("node:fs").closeSync(1); setInterval(() => {}, 60000);'
            : "setInterval(() => {}, 60000);";
    try {
      const exit = await Effect.runPromiseExit(
        startDetachedAgentRelayWorker({
          app,
          plan: { id: AppId.make(app.id), provider: ProviderId.make("docker") },
          upstream: { _tag: "unix", path: join(root, "upstream.sock") },
          kind: "ssh",
          delivery: "bind-directory",
          socketName: "agent.sock",
          paths: { userCacheRoot: root, userDataRoot: root },
          privateFileAccess: { enforce: async (path) => chmod(path, 0o600), verify: async () => undefined },
          spawnWorker: (spec) =>
            spawnDetachedWorker(
              { ...spec, argv: [process.execPath, "-e", source, "--app-id", app.id] },
              {
                readySchema: AgentRelayWorkerReady,
                logLabel: "agent-relay",
                readyTimeoutMs: failure === "timeout" ? 25 : 5000,
              },
            ),
        }),
      );
      if (exit._tag === "Success") {
        await exit.value.close();
        throw new Error("Expected startup failure");
      }
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(error).toMatchObject({
        _tag: "SshAgentTransportError",
        stage: "worker",
        remediation: `Inspect ${join(root, "logs", "agent-relay-worker-failure.log")} for the worker crash.`,
      });
      expect(error.message).not.toContain("ready-frame-credential");
      if (failure === "exit") {
        expect(error.message).toContain("exitCode=9");
        expect(error.message).toContain("relay crashed");
      } else {
        expect(error.message).not.toContain("exitCode");
        if (failure === "invalid-ready") expect(error.message).toContain("invalid readiness frame");
        if (failure === "stdout-eof") expect(error.message).toContain("stdout closed");
        if (failure === "timeout") expect(error.message).toContain("readiness timed out");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`source dispatcher publishes authenticated readiness and shuts down on ${signal}`, async () => {
    // Given a real source worker using isolated local sockets.
    const root = await mkdtemp(join(tmpdir(), "lando-agent-process-"));
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dirname, "../../../bin/lando.ts"),
        AGENT_RELAY_WORKER_COMMAND,
        "--app-id",
        "test",
      ],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LANDO_USER_DATA_ROOT: root,
          LANDO_USER_CONF_ROOT: root,
          LANDO_USER_CACHE_ROOT: root,
        },
      },
    );
    try {
      // When it consumes the worker input and the parent terminates its session.
      await proc.stdin.write(
        JSON.stringify({
          app: { kind: "user", id: "test", root },
          plan: { id: "test", provider: "docker" },
          kind: "ssh",
          configDigest: "sha256-process-test",
          upstream: { _tag: "unix", path: join(root, "upstream.sock") },
          delivery: "bind-directory",
          socketName: "agent.sock",
          paths: { userDataRoot: root },
        }),
      );
      await proc.stdin.end();
      const reader = proc.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(`Worker exited before ready: ${await new Response(proc.stderr).text()}`);
        text += new TextDecoder().decode(chunk.value);
      }
      const ready = Schema.decodeUnknownSync(Schema.fromJsonString(AgentRelayWorkerReady))(text.trim());
      expect(await identifyAgentRelayWorker(ready)).toMatchObject({
        pid: proc.pid,
        appId: "test",
        sessionId: ready.sessionId,
        configDigest: "sha256-process-test",
        protocolVersion: 2,
      });
      if (ready.mount._tag !== "bind-directory") throw new Error("Expected bind-directory mount");
      expect((await stat(join(ready.mount.directory, ready.socketName))).mode & 0o777).toBe(0o666);
      proc.kill(signal);
      // Then the CLI exits with the conventional interrupt status and the listener resources are gone.
      expect(await proc.exited).toBe(signal === "SIGTERM" ? 143 : 130);
      const controlClosed = await identifyAgentRelayWorker(ready).then(
        () => false,
        () => true,
      );
      expect(controlClosed).toBe(true);
      expect(await Bun.file(join(ready.mount.directory, ready.socketName)).exists()).toBe(false);
      reader.releaseLock();
    } finally {
      proc.kill();
      await proc.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test("bridge failure exits non-zero before readiness", async () => {
  // Given a worker with an injected failing provider bridge.
  const root = await mkdtemp(join(tmpdir(), "lando-agent-bridge-failure-"));
  const proc = Bun.spawn([process.execPath, join(import.meta.dirname, "failing-worker.ts")], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // When the provider fails to acquire the bridge.
    await proc.stdin.write(
      JSON.stringify({
        app: { kind: "user", id: "test", root },
        plan: { id: "test", provider: "docker" },
        kind: "ssh",
        configDigest: "sha256-failure-test",
        upstream: { _tag: "loopback-tcp", port: 43210 },
        delivery: "volume-relay",
        socketName: "agent.sock",
        paths: { userDataRoot: root },
      }),
    );
    await proc.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // Then the protocol emits no readiness or sensitive diagnostics.
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("sensitive-provider-diagnostic");
  } finally {
    proc.kill();
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["ssh", "gpg"] as const)(
  "real %s ensure reuses the authenticated process and directory",
  async (kind) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-agent-ensure-"));
    const app = { kind: "user" as const, id: "ensure", root: AbsolutePath.make(root) };
    const options = {
      app,
      kind,
      plan: { id: AppId.make(app.id), provider: ProviderId.make("docker") },
      upstream: { _tag: "unix" as const, path: join(root, "upstream.sock") },
      delivery: "bind-directory" as const,
      socketName: "agent.sock",
      paths: { userDataRoot: root },
      privateFileAccess: {
        enforce: async (path: string) => chmod(path, 0o600),
        verify: async (path: string) => {
          if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error("Not private");
        },
      },
    };
    const paths = sshAgentSessionPaths(app, options.paths, kind);
    let session: AgentRelaySession | undefined;
    try {
      session = await Effect.runPromise(startDetachedAgentRelayWorker(options));
      const firstRecord = await readFile(paths.recordPath, "utf8");
      const before = await stat(paths.socketDir);
      await writeFile(join(paths.stateDir, "retained"), "keep");
      // When
      const reused = await Effect.runPromise(startDetachedAgentRelayWorker(options));
      session = reused;
      // Then
      expect(await readFile(paths.recordPath, "utf8")).toBe(firstRecord);
      expect((await stat(paths.socketDir)).ino).toBe(before.ino);
      expect(await readFile(join(paths.stateDir, "retained"), "utf8")).toBe("keep");
      const record = Schema.decodeUnknownSync(AgentRelayWorkerReady)({
        ...JSON.parse(firstRecord),
        _tag: "ready",
      });
      expect(await identifyAgentRelayWorker(record)).toMatchObject({
        pid: record.pid,
        sessionId: reused.sessionId,
        configDigest: record.configDigest,
        protocolVersion: 2,
      });
      await reused.close();
      await expect(identifyAgentRelayWorker(record)).rejects.toMatchObject({
        _tag: "SshAgentTransportError",
      });
    } finally {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
