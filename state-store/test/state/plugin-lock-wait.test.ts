import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";

import { ADVISORY_LOCK_SUFFIX } from "../../src/lock.ts";
import { makePluginStateStore } from "../../src/plugin.ts";
import { makeTestStateStore } from "../../src/testing.ts";
import { lockTestAccess } from "./lock-test-access.ts";
import { sourceHolderCommand, spawnHolder } from "./native-lock-support.ts";

const pluginLockKey = "routes.lock";

test("plugin lock can wait past the default deadline for a live process", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-plugin-lock-wait-")));
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { AbsolutePath } from ${JSON.stringify(import.meta.resolve("@lando/sdk/schema"))};
        import { makePluginStateStore } from ${JSON.stringify(import.meta.resolve("../../src/plugin.ts"))};
        import { makeTestStateStore } from ${JSON.stringify(import.meta.resolve("../../src/testing.ts"))};
        import { lockTestAccess } from ${JSON.stringify(import.meta.resolve("./lock-test-access.ts"))};
        const store = makePluginStateStore(
          makeTestStateStore().service,
          AbsolutePath.make(${JSON.stringify(root)}),
          lockTestAccess,
        );
        await Effect.runPromise(store.withLock(${JSON.stringify(pluginLockKey)}, Effect.promise(async () => {
          process.stdout.write("held\\n");
          // Hold until the parent closes stdin, so release never races the parent's wait.
          await Bun.stdin.text();
        })));
      `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("held");
    const store = makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), lockTestAccess);
    const startedAt = performance.now();
    const acquiring = Effect.runPromise(
      store.withLock(
        pluginLockKey,
        Effect.sync(() => performance.now()),
        { timeoutMs: 5_000 },
      ),
    );
    // The wait past the 2 s default deadline is the behavior under test, so this hold is time-based.
    await Bun.sleep(2_500);
    child.stdin.end();
    const acquiredAt = await acquiring;
    expect(acquiredAt - startedAt).toBeGreaterThan(2_000);
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin lock rejects an unbounded runtime wait before opening a lock", async () => {
  const store = makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(join(tmpdir(), "lando-invalid-plugin-lock-wait")),
    lockTestAccess,
  );
  const error = await Effect.runPromise(
    Effect.flip(
      store.withLock(pluginLockKey, Effect.succeed("unused"), { timeoutMs: Number.POSITIVE_INFINITY }),
    ),
  );
  expect(error._tag).toBe("StateStoreError");
  expect(error.reason).toBe("lock");
  expect(error.remediation).toContain("finite plugin lock wait");
});

test("plugin lock ignores stale diagnostic bytes and old .lock suffixes", async () => {
  // Records and legacy pid-file paths are not reclaim authority under kernel locks.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-plugin-lock-stale-")));
  const lockDir = join(root, "locks");
  const target = join(lockDir, pluginLockKey);
  const sentinel = `${target}${ADVISORY_LOCK_SUFFIX}`;
  const legacyDouble = `${target}.lock`;
  const stale = JSON.stringify({
    pid: process.pid,
    token: "live-owner",
    createdAt: Date.now() - 60_000,
  });
  await mkdir(lockDir);
  await writeFile(sentinel, stale, { mode: 0o600 });
  await writeFile(legacyDouble, stale, { mode: 0o600 });
  try {
    const store = makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), lockTestAccess);
    const acquired = await Effect.runPromise(
      store.withLock(pluginLockKey, Effect.succeed("acquired"), { timeoutMs: 2_000 }),
    );
    expect(acquired).toBe("acquired");
    expect(await Bun.file(sentinel).exists()).toBe(process.platform === "win32");
    expect(await readFile(legacyDouble, "utf8")).toBe(stale);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin lock times out against a live kernel holder without taking the lock", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-plugin-lock-live-")));
  const lockDir = join(root, "locks");
  const target = join(lockDir, pluginLockKey);
  const sentinel = `${target}${ADVISORY_LOCK_SUFFIX}`;
  await mkdir(lockDir);
  const holder = await spawnHolder(sourceHolderCommand(), sentinel, {
    mode: "exclusive",
    resource: pluginLockKey,
  });
  try {
    const store = makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), lockTestAccess);
    let bodyRan = false;
    const result = await Effect.runPromise(
      Effect.result(
        store.withLock(
          pluginLockKey,
          Effect.sync(() => {
            bodyRan = true;
            return "incorrect takeover";
          }),
          { timeoutMs: 80 },
        ),
      ),
    );
    expect(bodyRan).toBe(false);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "StateStoreError",
        reason: "lock",
        lockFailure: "timeout",
        ownerPid: holder.pid,
        timeoutMs: 80,
      });
    }
  } finally {
    holder.release();
    await holder.exited;
    await rm(root, { recursive: true, force: true });
  }
});
