import { describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";
import { acquireAdvisoryLockAt } from "../../src/lock.ts";
import { makePrivateFileAccessWorker } from "../../src/private-file-worker.ts";
import { makeRecordingWorkerSpawn } from "../private-file-worker.ts";

const makeWorker = (spawn: ReturnType<typeof makeRecordingWorkerSpawn>) =>
  makePrivateFileAccessWorker({
    systemRoot: "D:\\Windows",
    env: {},
    spawn: spawn.spawn,
  });

const closesPromptly = async (close: Promise<void>): Promise<boolean> =>
  Promise.race([close.then(() => true), Bun.sleep(100).then(() => false)]);

const settlesAsRejected = async (operation: Promise<void>): Promise<boolean> =>
  operation.then(
    () => false,
    () => true,
  );

describe("private-file ACL worker lifecycle", () => {
  test.each(["write", "flush"] as const)("bounds a stalled stdin %s", async (method) => {
    const spawn = makeRecordingWorkerSpawn();
    const worker = makePrivateFileAccessWorker({
      systemRoot: "D:\\Windows",
      env: {},
      timeoutMs: 25,
      spawn: (command, options) => {
        const child = spawn.spawn(command, options);
        return { ...child, stdin: { ...child.stdin, [method]: () => new Promise<number>(() => undefined) } };
      },
    });
    try {
      const outcome = await Promise.race([
        worker.enforce("D:\\tmp\\lock").then(
          () => "accepted",
          () => "rejected",
        ),
        Bun.sleep(1000).then(() => "stalled"),
      ]);
      expect(outcome).toBe("rejected");
      expect(spawn.killCount()).toBe(1);
    } finally {
      await worker.close();
    }
  });
  test.each(["enforce", "verify"] as const)(
    "bounds a stalled %s during lock acquisition",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), "lando-stalled-acl-"));
      const lockPath = join(root, "mutation.lock");
      const binary = join(root, "lando");
      const candidate = join(root, "candidate");
      await writeFile(binary, "old");
      await writeFile(candidate, "new");
      if (operation === "verify")
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, token: "other", createdAt: Date.now() }),
          { mode: 0o600 },
        );
      const spawn = makeRecordingWorkerSpawn(() => new Promise(() => undefined));
      const worker = makePrivateFileAccessWorker({
        systemRoot: "D:\\Windows",
        env: {},
        spawn: spawn.spawn,
        timeoutMs: 25,
      });
      try {
        const acquisition = Effect.runPromise(
          Effect.either(
            Effect.acquireUseRelease(
              acquireAdvisoryLockAt(lockPath, "replacement", {
                privateFileAccess: worker,
                expireLiveOwner: false,
              }),
              () => Effect.tryPromise(() => rename(candidate, binary)),
              (lock) => lock.release,
            ),
          ),
        );
        const outcome = await Promise.race([acquisition, Bun.sleep(1000).then(() => "stalled" as const)]);
        expect(outcome).not.toBe("stalled");
        if (outcome === "stalled") return;
        expect(Either.isLeft(outcome) && outcome.left._tag).toBe("StateStoreError");
        expect(spawn.requests[0]?.operation).toBe(operation);
        expect(spawn.killCount()).toBe(1);
        expect(await Bun.file(binary).text()).toBe("old");
        expect(await Bun.file(candidate).text()).toBe("new");
        expect(await Bun.file(lockPath).exists()).toBe(operation === "verify");
      } finally {
        await worker.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["enforce", "verify"] as const)(
    "sends ASCII-only %s frames for Unicode paths",
    async (operation) => {
      // Given non-ASCII names, a surrogate pair, and isolated UTF-16 surrogate code units
      const path = "D:\\café-資料-😀\\秘密-\ud800-\udfff.json";
      const spawn = makeRecordingWorkerSpawn();
      const worker = makeWorker(spawn);
      try {
        // When the path crosses the subprocess boundary
        await worker[operation](path);
        // Then every wire byte is ASCII and the semantic path is preserved exactly
        expect(spawn.frames).toHaveLength(1);
        expect(spawn.frames.every((frame) => frame.every((byte) => byte < 128))).toBe(true);
        expect(spawn.requests).toEqual([{ id: "1", operation, path }]);
      } finally {
        await worker.close();
      }
    },
  );

  test("closes promptly while an active request never responds", async () => {
    // Given an active request whose worker never writes a response
    const spawn = makeRecordingWorkerSpawn(() => new Promise(() => undefined));
    const worker = makeWorker(spawn);
    const active = worker.enforce("D:\\tmp\\active.json");
    void active.catch(() => undefined);
    await spawn.firstRequest;

    // When the worker is closed
    const close = worker.close();

    // Then close resolves promptly, kills the child, and rejects the active request
    expect(await closesPromptly(close)).toBe(true);
    expect(spawn.killCount()).toBe(1);
    expect(await settlesAsRejected(active)).toBe(true);
  });

  test("rejects queued requests without executing them when closed", async () => {
    // Given one active request and one queued request
    const spawn = makeRecordingWorkerSpawn(() => new Promise(() => undefined));
    const worker = makeWorker(spawn);
    const active = worker.enforce("D:\\tmp\\active.json");
    const queued = worker.verify("D:\\tmp\\queued.json");
    void active.catch(() => undefined);
    void queued.catch(() => undefined);
    await spawn.firstRequest;

    // When the worker is closed
    const close = worker.close();

    // Then both requests reject and the queued request never reaches PowerShell
    expect(await closesPromptly(close)).toBe(true);
    expect(await settlesAsRejected(active)).toBe(true);
    expect(await settlesAsRejected(queued)).toBe(true);
    expect(spawn.requests.map(({ path }) => path)).toEqual(["D:\\tmp\\active.json"]);
  });

  test("rejects use after close without spawning a process", async () => {
    // Given a worker whose scope has closed before first use
    const spawn = makeRecordingWorkerSpawn();
    const worker = makeWorker(spawn);
    await worker.close();

    // When an operation starts after close, then it fails without spawning PowerShell
    expect(await settlesAsRejected(worker.enforce("D:\\tmp\\late.json"))).toBe(true);
    expect(spawn.spawnCount()).toBe(0);
    await worker.close();
  });

  test("does not emit unhandled rejections while closing active and queued requests", async () => {
    // Given handled active and queued requests plus an unhandled-rejection observer
    const unhandled: unknown[] = [];
    const onUnhandled = (event: Event): void => {
      if ("reason" in event) unhandled.push(event.reason);
    };
    globalThis.addEventListener("unhandledrejection", onUnhandled);
    try {
      const spawn = makeRecordingWorkerSpawn(() => new Promise(() => undefined));
      const worker = makeWorker(spawn);
      const active = worker.enforce("D:\\tmp\\active.json");
      const queued = worker.verify("D:\\tmp\\queued.json");
      await spawn.firstRequest;

      // When close interrupts both requests
      const close = worker.close();

      // Then every promise settles through its caller without an unhandled rejection
      expect(await closesPromptly(close)).toBe(true);
      const results = await Promise.allSettled([active, queued]);
      expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});
