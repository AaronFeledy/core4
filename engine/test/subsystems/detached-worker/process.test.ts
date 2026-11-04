import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { spawnDetachedWorker } from "../../../src/subsystems/detached-worker/process.ts";
import { ownerOnlyFileAccess } from "../../private-file-access.ts";

const readySchema = Schema.TaggedStruct("ready", { token: Schema.String });

describe("detached worker readiness diagnostics", () => {
  test("masks the worker environment in early-exit log diagnostics", async () => {
    // Given: a worker writes an unlabelled environment secret to its real log.
    const root = await mkdtemp(join(tmpdir(), "worker-env-crash-"));
    const secret = "detached-worker-environment-canary";
    const worker = await spawnDetachedWorker(
      {
        argv: [process.execPath, "-e", "console.error(process.env.P5_WORKER_SECRET); process.exit(7);"],
        env: { ...process.env, P5_WORKER_SECRET: secret },
        logsDir: root,
        privateFileAccess: ownerOnlyFileAccess,
      },
      { readySchema, logLabel: "test" },
    );
    try {
      // When: readiness reports the worker's actual early exit.
      const failure = await worker.readReady().catch((cause: unknown) => cause);
      // Then: the log projection masks the environment value before rendering it.
      expect(failure).toMatchObject({
        name: "DetachedWorkerExitedBeforeReadyError",
        stderrTail: "[redacted]",
      });
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not ignore worker stderr for the worker lifetime", async () => {
    const source = await Bun.file(
      new URL("../../../src/subsystems/detached-worker/process.ts", import.meta.url),
    ).text();
    expect(source).not.toContain('stderr: "ignore"');
  });

  test("captures stderr, creates logsDir, and reports exitCode on early exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-crash-"));
    const worker = await spawnDetachedWorker(
      {
        argv: [
          process.execPath,
          "-e",
          'console.error("worker boom: missing compiled entry"); process.exit(7);',
        ],
        logsDir: join(root, "logs"),
        privateFileAccess: ownerOnlyFileAccess,
      },
      { readySchema, logLabel: "test" },
    );
    try {
      const failure = await worker.readReady().catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ name: "DetachedWorkerExitedBeforeReadyError", exitCode: 7 });
      expect(String(failure)).toContain("worker boom: missing compiled entry");
      expect(await Bun.file(worker.logPath).text()).toContain("worker boom: missing compiled entry");
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "{not-json-credential",
    JSON.stringify({ _tag: "ready", token: { credential: "schema-failure-credential" } }),
  ])("never echoes an invalid ready frame %s", async (line) => {
    const root = await mkdtemp(join(tmpdir(), "worker-ready-decode-"));
    const worker = await spawnDetachedWorker(
      {
        argv: [process.execPath, "-e", `console.log(${JSON.stringify(line)}); setInterval(() => {}, 60000);`],
        logsDir: root,
        privateFileAccess: ownerOnlyFileAccess,
      },
      { readySchema, logLabel: "test" },
    );
    try {
      const failure = await worker.readReady().catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ name: "DetachedWorkerStartupError", logPath: worker.logPath });
      expect(String(failure)).not.toContain(line);
      expect(String(failure)).not.toContain("credential");
      expect(String(failure)).toContain(worker.logPath);
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])("reports closed stdin with the observed exit state (exits=%s)", async (exits) => {
    const root = await mkdtemp(join(tmpdir(), "worker-dead-write-"));
    const connection = Promise.withResolvers<import("node:net").Socket>();
    const server = createServer((socket) => connection.resolve(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing control port");
    const worker = await spawnDetachedWorker(
      {
        argv: [
          process.execPath,
          "-e",
          `const { closeSync } = require("node:fs");
           const { connect } = require("node:net");
           closeSync(0);
           const socket = connect(${address.port}, "127.0.0.1", () => {
             console.log(JSON.stringify({_tag:"ready",token:"test"}));
           });
           socket.on("data", () => { console.error("controlled worker crash"); process.exit(7); });`,
        ],
        logsDir: root,
        privateFileAccess: ownerOnlyFileAccess,
      },
      { readySchema, logLabel: "test" },
    );
    const socket = await connection.promise;
    try {
      await worker.readReady();
      const started = performance.now();
      const delivery = worker.writeStdin("x".repeat(2 * 1024 * 1024));
      if (exits) socket.write("exit");
      const failure = await delivery.catch((cause: unknown) => cause);
      expect(failure).toMatchObject({
        name: exits ? "DetachedWorkerExitedBeforeReadyError" : "DetachedWorkerStartupError",
        logPath: worker.logPath,
      });
      if (exits) {
        expect(failure).toHaveProperty("exitCode", 7);
        expect(String(failure)).toContain("controlled worker crash");
      } else {
        expect(failure).not.toHaveProperty("exitCode");
      }
      expect(String(failure)).toContain(worker.logPath);
      expect(performance.now() - started).toBeLessThan(4000);
    } finally {
      await worker.terminate();
      socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
});
