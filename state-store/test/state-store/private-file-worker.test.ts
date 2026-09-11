import { describe, expect, test } from "bun:test";
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
