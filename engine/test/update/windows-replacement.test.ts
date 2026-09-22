// allow: SIZE_OK — Required deferred-swap acceptance matrix stays with its existing lock regressions in this owned test file.
import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOwnedExecutable } from "@lando/engine/install/owned-executable";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { Effect, Either } from "effect";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeUpdateHandoff } from "../../src/update/handoff.ts";
import { runWindowsReplacement } from "../../src/update/windows.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (name = "lando4.exe") => {
  const root = await mkdtemp(join(tmpdir(), "lando-windows-replace-"));
  roots.push(root);
  const pluginsRoot = join(root, "plugins");
  await mkdir(pluginsRoot);
  const executablePath = join(root, name);
  const stagedBinaryPath = join(root, "candidate.exe");
  await writeFile(executablePath, "old");
  await writeFile(stagedBinaryPath, "new");
  const installRecordFile = join(root, "record.json");
  const record = {
    version: 1,
    data: {
      executable: {
        path: executablePath,
        sha256: Bun.SHA256.hash("old", "hex"),
        size: 3,
        channel: "stable",
        platform: "windows-x64",
        releaseVersion: "4.1.0",
      },
      shellProfiles: [{ path: join(root, "profile.ps1"), blockSha256: "a".repeat(64) }],
    },
  };
  await writeFile(installRecordFile, JSON.stringify(record), { mode: 0o600 });
  const store = makeTestStateStore();
  const handoff = makeUpdateHandoff(store.service);
  const result = {
    updatedCore: false,
    updatedPlugins: ["fixture"],
    pluginResults: [
      {
        kind: "plugin",
        name: "fixture",
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "update",
        reason: "selected",
      },
    ],
  } as const;
  const token = await Effect.runPromise(handoff.saveDeferred(result));
  const input = {
    executablePath,
    installRecordFile,
    stagedBinaryPath,
    backupPath: `${executablePath}.bak`,
    attemptedVersion: "4.2.0",
    manualFallback: "retry",
    token,
    precondition: { pluginsRoot, currentCoreVersion: "4.1.0", targetCoreVersion: "4.2.0" },
  };
  return { root, input, store, handoff, result, record };
};

test("aborts under lock when fresh compatibility fails and preserves completed receipts", async () => {
  const f = await fixture();
  await writeFile(join(f.input.precondition.pluginsRoot, "registry.json"), "corrupt");
  await Effect.runPromise(runWindowsReplacement(f.input, f.handoff));
  expect(await Bun.file(f.input.executablePath).text()).toBe("old");
  expect(await Bun.file(f.input.stagedBinaryPath).text()).toBe("new");
  const receipt = await Effect.runPromise(f.handoff.consumeDeferred(f.input.token));
  expect(receipt?.updatedCore).toBe(false);
  expect(receipt?.hasFailures).toBe(true);
  expect(receipt?.coreFailure?.remediation).toContain("re-run lando update");
  expect(receipt?.pluginResults).toEqual(f.result.pluginResults);
  expect(receipt?.updatedPlugins).toEqual(f.result.updatedPlugins);
});

test.each(["lando4.exe", "LANDO4.EXE"])(
  "refreshes ownership after replacing %s without touching Lando 3",
  async (name) => {
    // Given an owned executable beside an unrelated Lando 3 installation.
    const f = await fixture(name);
    const foreign = join(f.root, "lando.exe");
    await writeFile(foreign, "lando3");
    await writeFile(f.input.stagedBinaryPath, "new-version-bytes");
    const finish = spyOn(f.handoff, "finishDeferred");
    const moves: string[][] = [];
    // When the helper swaps using a copy-backed move fake (no real rename).
    await Effect.runPromise(
      runWindowsReplacement(f.input, f.handoff, async (from, to) => {
        moves.push([from, to]);
        await copyFile(from, to);
      }),
    );
    // Then only Lando 4 is replaced and its durable ownership follows the new bytes.
    expect(moves).toEqual([
      [f.input.executablePath, f.input.backupPath],
      [f.input.stagedBinaryPath, f.input.executablePath],
    ]);
    expect(await Bun.file(foreign).text()).toBe("lando3");
    expect(await Bun.file(f.input.installRecordFile).json()).toEqual({
      ...f.record,
      data: {
        ...f.record.data,
        executable: {
          ...f.record.data.executable,
          sha256: Bun.SHA256.hash("new-version-bytes", "hex"),
          size: 17,
          releaseVersion: "4.2.0",
        },
      },
    });
    expect(finish).toHaveBeenCalledWith(f.input.token, undefined);
  },
);

test.each(["lando.exe", "lando4", "digest-drift", "path-mismatch"])(
  "refuses %s at swap time without moving anything",
  async (scenario) => {
    // Given a real record that is foreign, stale, or does not name the requested target.
    const f = await fixture(scenario === "lando.exe" || scenario === "lando4" ? scenario : "lando4.exe");
    if (scenario === "digest-drift") await writeFile(f.input.executablePath, "bad");
    const input = {
      ...f.input,
      executablePath:
        scenario === "path-mismatch" ? join(f.root, "other", "lando4.exe") : f.input.executablePath,
    };
    const refusal = await Effect.runPromise(
      Effect.either(
        resolveOwnedExecutable({
          recordFile: input.installRecordFile,
          platform: "win32",
          destination: input.executablePath,
        }),
      ),
    );
    if (Either.isRight(refusal)) throw new Error("Expected ownership refusal");
    expect(refusal.left.reason).toBe(
      scenario === "digest-drift"
        ? "digest-mismatch"
        : scenario === "path-mismatch"
          ? "path-mismatch"
          : "foreign-basename",
    );
    const moves: string[][] = [];
    // When the deferred helper authorizes the request again.
    await Effect.runPromise(
      runWindowsReplacement(input, f.handoff, async (from, to) => {
        moves.push([from, to]);
      }),
    );
    // Then it forwards the canonical refusal without a filesystem move.
    expect(moves).toEqual([]);
    expect((await Effect.runPromise(f.handoff.consumeDeferred(input.token)))?.coreFailure).toEqual({
      tag: "InstallOwnershipError",
      message: refusal.left.message,
      remediation: refusal.left.remediation,
    });
  },
);

test.each(["second-move", "record-refresh"])(
  "rolls back without refreshing the record when %s fails",
  async (failure) => {
    // Given an owned binary and a recoverable original record.
    const f = await fixture();
    const before = await Bun.file(f.input.installRecordFile).text();
    const moves: string[][] = [];
    // When either installation or record persistence fails after the backup move.
    await Effect.runPromise(
      runWindowsReplacement(f.input, f.handoff, async (from, to) => {
        moves.push([from, to]);
        if (from === f.input.stagedBinaryPath && failure === "second-move") throw new Error("move failed");
        await copyFile(from, to);
        if (from === f.input.stagedBinaryPath && failure === "record-refresh") {
          await rm(f.input.installRecordFile);
          await mkdir(f.input.installRecordFile);
        }
      }),
    );
    // Then the backup is restored and a failure receipt is finalized.
    expect(moves).toEqual([
      [f.input.executablePath, f.input.backupPath],
      [f.input.stagedBinaryPath, f.input.executablePath],
      [f.input.backupPath, f.input.executablePath],
    ]);
    expect(await Bun.file(f.input.executablePath).text()).toBe("old");
    if (failure === "second-move") expect(await Bun.file(f.input.installRecordFile).text()).toBe(before);
    expect((await Effect.runPromise(f.handoff.consumeDeferred(f.input.token)))?.coreFailure?.tag).toBe(
      failure === "second-move" ? "UpdatePermissionError" : "InstallOwnershipError",
    );
  },
);

test("holds the mutation lock through both moves and makes the outcome available exactly once", async () => {
  const f = await fixture();
  expect(await Effect.runPromise(f.handoff.consumeDeferred(f.input.token))).toBeUndefined();
  let moves = 0;
  const lock = Bun.file(join(f.input.precondition.pluginsRoot, ".lando-plugin-mutation.lock"));
  await Effect.runPromise(
    runWindowsReplacement(f.input, f.handoff, async (from, to) => {
      expect(await lock.exists()).toBe(true);
      moves += 1;
      await rename(from, to);
    }),
  );
  expect(moves).toBe(2);
  expect(await Bun.file(join(f.input.precondition.pluginsRoot, ".lando-plugin-mutation.lock")).exists()).toBe(
    false,
  );
  expect(await Bun.file(f.input.executablePath).text()).toBe("new");
  expect(await Bun.file(f.input.backupPath).text()).toBe("old");
  expect((await Effect.runPromise(f.handoff.consumeDeferred(f.input.token)))?.updatedCore).toBe(true);
  expect(await Effect.runPromise(f.handoff.consumeDeferred(f.input.token))).toBeUndefined();
});

test("a competing lock participant cannot mutate between validation and replacement", async () => {
  const f = await fixture();
  const attempted = Promise.withResolvers<void>();
  let mutated = false;
  let competitor: Promise<void> | undefined;
  const lockPath = join(f.input.precondition.pluginsRoot, ".lando-plugin-mutation.lock");
  await Effect.runPromise(
    runWindowsReplacement(f.input, f.handoff, async (from, to) => {
      if (from === f.input.executablePath) {
        competitor = Effect.runPromise(
          Effect.acquireUseRelease(
            acquireAdvisoryLockAt(lockPath, "plugin:add", {
              expireLiveOwner: false,
              privateFileAccess: {
                enforce: async () => undefined,
                verify: async () => {
                  attempted.resolve();
                },
              },
            }),
            () =>
              Effect.promise(async () => {
                expect(await Bun.file(f.input.executablePath).text()).toBe("new");
                await writeFile(
                  join(f.input.precondition.pluginsRoot, "registry.json"),
                  "competing mutation",
                );
                mutated = true;
              }),
            (lock) => lock.release,
          ),
        );
        await attempted.promise;
      }
      expect(mutated).toBe(false);
      await rename(from, to);
    }),
  );
  await competitor;
  expect(mutated).toBe(true);
  expect(await Bun.file(f.input.executablePath).text()).toBe("new");
});

test.each(["^4.0.0", "<4.2.0"])(
  "fresh active requirements %s determine whether replacement proceeds",
  async (range) => {
    const f = await fixture();
    const plugin = join(f.root, "active");
    await mkdir(plugin);
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "active",
        version: "1.0.0",
        landoPlugin: {
          name: "active",
          version: "1.0.0",
          api: 4,
          entry: "index.js",
          requires: { "@lando/core": range },
        },
      }),
    );
    await writeFile(join(plugin, "index.js"), "export {};");
    await writeFile(
      join(f.input.precondition.pluginsRoot, "registry.json"),
      JSON.stringify({
        active: { name: "active", version: "1.0.0", path: plugin, source: "linked" },
      }),
    );
    await Effect.runPromise(runWindowsReplacement(f.input, f.handoff));
    expect(await Bun.file(f.input.executablePath).text()).toBe(range === "^4.0.0" ? "new" : "old");
  },
);

test("lock timeout leaves the existing binary in place and records remediation", async () => {
  const f = await fixture();
  await writeFile(
    join(f.input.precondition.pluginsRoot, ".lando-plugin-mutation.lock"),
    JSON.stringify({
      pid: process.pid,
      token: "another-process",
      createdAt: Date.now() - 60_000,
    }),
    { mode: 0o600 },
  );
  await Effect.runPromise(runWindowsReplacement(f.input, f.handoff));
  expect(await Bun.file(f.input.executablePath).text()).toBe("old");
  expect(await Bun.file(f.input.stagedBinaryPath).text()).toBe("new");
  const receipt = await Effect.runPromise(f.handoff.consumeDeferred(f.input.token));
  expect(receipt?.hasFailures).toBe(true);
  expect(receipt?.coreFailure?.message).toContain("lock");
  expect(receipt?.updatedPlugins).toEqual(f.result.updatedPlugins);
});
