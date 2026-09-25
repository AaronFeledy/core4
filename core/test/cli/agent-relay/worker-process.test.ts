import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_RELAY_WORKER_COMMAND,
  AgentRelayWorkerReady,
  identifyAgentRelayWorker,
} from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import { Schema } from "effect";

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
      const ready = Schema.decodeUnknownSync(Schema.parseJson(AgentRelayWorkerReady))(text.trim());
      expect(await identifyAgentRelayWorker(ready)).toMatchObject({
        pid: proc.pid,
        appId: "test",
        sessionId: ready.sessionId,
      });
      if (ready.mount._tag !== "bind-directory") throw new Error("Expected bind-directory mount");
      expect((await stat(join(ready.mount.directory, ready.socketName))).mode & 0o777).toBe(0o666);
      proc.kill(signal);
      // Then shutdown completes successfully and the listener resources are gone.
      expect(await proc.exited).toBe(0);
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
