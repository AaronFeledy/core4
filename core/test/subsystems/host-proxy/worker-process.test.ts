import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Option } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

import { startDetachedHostProxyWorker } from "../../../src/subsystems/host-proxy/detached-worker.ts";
import { defaultSpawnWorker } from "../../../src/subsystems/host-proxy/worker-process.ts";
import { workerStatePath } from "../../../src/subsystems/host-proxy/worker-state.ts";

const MEBIBYTE = 1024 * 1024;
const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };
const plan: AppPlan = {
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: app.root,
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
    source: "worker-process.test",
    runtime: 4,
  },
  extensions: {},
};

const hasNodeCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && hasNodeCode(cause, "ESRCH")) return false;
    throw cause;
  }
};

const makeInputWorker = async (root: string): Promise<string> => {
  const path = join(root, "input-worker.ts");
  await writeFile(
    path,
    `const delayMs = Number(process.argv[2] ?? "0");
if (delayMs > 0) await Bun.sleep(delayMs);
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({
  _tag: "ready",
  appId: "demo",
  sessionId: "session-input",
  token: String(Buffer.byteLength(input)),
  controlToken: "control-token",
  socketPath: "/tmp/host-proxy.sock",
  shimPath: "/tmp/lando",
}));
`,
  );
  return path;
};

describe("detached host-proxy worker payload delivery", () => {
  test("delivers the complete payload before closing worker stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-input-"));
    const worker = defaultSpawnWorker({ argv: [process.execPath, await makeInputWorker(root), "0"] });
    try {
      const payload = "complete payload\n";

      await worker.writeStdin(payload);
      const ready = await worker.readReady();

      expect(ready.token).toBe(String(Buffer.byteLength(payload)));
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits for a slow worker to drain pipe backpressure", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-input-"));
    const worker = defaultSpawnWorker({ argv: [process.execPath, await makeInputWorker(root), "250"] });
    try {
      const payload = "x".repeat(2 * MEBIBYTE);
      let delivered = false;

      const delivery = worker.writeStdin(payload).then(() => {
        delivered = true;
      });
      await Bun.sleep(50);

      expect(delivered).toBe(false);
      await delivery;
      const ready = await worker.readReady();
      expect(ready.token).toBe(String(Buffer.byteLength(payload)));
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a payload larger than the bounded startup frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-input-"));
    const worker = defaultSpawnWorker({ argv: [process.execPath, await makeInputWorker(root), "5000"] });
    try {
      const oversized = "x".repeat(16 * MEBIBYTE + 1);
      let failure: Error | undefined;

      try {
        await worker.writeStdin(oversized);
      } catch (cause) {
        if (cause instanceof Error) failure = cause;
        else throw cause;
      }

      if (failure === undefined) throw new Error("Expected oversized worker payload to fail.");
      expect(failure.message).toBe("Host-proxy worker startup payload exceeds the 16 MiB limit.");
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps oversized startup to a remediated tagged error and terminates the worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-input-"));
    const scriptPath = await makeInputWorker(root);
    let spawnedPid: number | undefined;
    const exit = await Effect.runPromiseExit(
      startDetachedHostProxyWorker({
        app,
        plan: { ...plan, name: "x".repeat(16 * MEBIBYTE + 1) },
        paths: { userDataRoot: root },
        shimArtifactPath: join(root, "lando"),
        spawnWorker: () => {
          const worker = defaultSpawnWorker({ argv: [process.execPath, scriptPath, "500"] });
          spawnedPid = worker.pid;
          return worker;
        },
      }),
    );
    try {
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Success") throw new Error("Expected oversized startup to fail.");
      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toMatchObject({
        _tag: "HostProxyTransportUnavailableError",
        message: "Host-proxy worker startup payload exceeds the 16 MiB limit.",
        remediation: "Inspect the detached host-proxy worker startup failure.",
      });
      expect(await Bun.file(workerStatePath(app, { userDataRoot: root })).exists()).toBe(false);
      expect(spawnedPid).toBeNumber();
      if (spawnedPid !== undefined) expect(pidIsAlive(spawnedPid)).toBe(false);
    } finally {
      if (exit._tag === "Success") await exit.value.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
