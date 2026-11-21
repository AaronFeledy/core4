// allow: SIZE_OK — Required deferred-swap acceptance matrix stays with its existing lock regressions in this owned test file.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOwnedExecutable } from "@lando/engine/install/owned-executable";
import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Deferred, Effect, Result } from "effect";
import { EventPublicationObserver, layer as eventLayer } from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeUpdateHandoff } from "../../src/update/handoff.ts";
import { runWindowsReplacement } from "../../src/update/windows.ts";

const pluginMutationSentinel = (pluginsRoot: string): string =>
  join(pluginsRoot, `.lando-plugin-mutation${ADVISORY_LOCK_SUFFIX}`);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (name = "lando.exe") => {
  const root = await mkdtemp(join(tmpdir(), "lando-windows-replace-"));
  roots.push(root);
  const pluginsRoot = join(root, "plugins");
  await mkdir(pluginsRoot);
  const executablePath = join(root, name);
  const stagedBinaryPath = join(root, "candidate.exe");
  await writeFile(executablePath, "old", { mode: 0o755 });
  await writeFile(stagedBinaryPath, "new", { mode: 0o755 });
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

test.each(["lando.exe", "LANDO.EXE", "lando4.exe", "LANDO4.EXE"])(
  "refreshes ownership after replacing %s without touching Lando 3",
  async (name) => {
    // Given an owned executable beside an unrelated Lando 3 installation.
    const f = await fixture(name);
    const foreign = join(f.root, "legacy", "lando.exe");
    await mkdir(join(f.root, "legacy"));
    await writeFile(foreign, "lando3");
    await writeFile(f.input.stagedBinaryPath, "new-version-bytes");
    const finish = spyOn(f.handoff, "finishDeferred");
    const moves: string[][] = [];
    // When the helper swaps temp fixtures through an observed filesystem adapter.
    await Effect.runPromise(
      runWindowsReplacement(f.input, f.handoff, async (from, to) => {
        moves.push([from, to]);
        expect(await Bun.file(f.input.executablePath).text()).toBe("old");
        expect(await Bun.file(f.input.backupPath).text()).toBe("old");
        await rename(from, to);
      }),
    );
    // Then only Lando 4 is replaced and its durable ownership follows the new bytes.
    expect(moves).toEqual([[f.input.stagedBinaryPath, f.input.executablePath]]);
    expect(await Bun.file(f.input.backupPath).text()).toBe("old");
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

test.each(["other.exe", "lando4", "digest-drift", "path-mismatch"])(
  "refuses %s at swap time without moving anything",
  async (scenario) => {
    // Given a real record that is foreign, stale, or does not name the requested target.
    const f = await fixture(scenario === "other.exe" || scenario === "lando4" ? scenario : "lando.exe");
    if (scenario === "digest-drift") await writeFile(f.input.executablePath, "bad");
    const input = {
      ...f.input,
      executablePath:
        scenario === "path-mismatch" ? join(f.root, "other", "lando4.exe") : f.input.executablePath,
    };
    const refusal = await Effect.runPromise(
      Effect.result(
        resolveOwnedExecutable({
          recordFile: input.installRecordFile,
          platform: "win32",
          destination: input.executablePath,
        }),
      ),
    );
    if (Result.isSuccess(refusal)) throw new Error("Expected ownership refusal");
    expect(refusal.failure.reason).toBe(
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
      message: refusal.failure.message,
      remediation: refusal.failure.remediation,
    });
  },
);

test.each(["replacement", "record-refresh"])(
  "rolls back without refreshing the record when %s fails",
  async (failure) => {
    // Given an owned binary and a recoverable original record.
    const f = await fixture();
    const before = await Bun.file(f.input.installRecordFile).text();
    const moves: string[][] = [];
    // When either installation or record persistence fails after backup creation.
    await Effect.runPromise(
      runWindowsReplacement(f.input, f.handoff, async (from, to) => {
        moves.push([from, to]);
        if (from === f.input.stagedBinaryPath && failure === "replacement") throw new Error("move failed");
        await rename(from, to);
        if (from === f.input.stagedBinaryPath && failure === "record-refresh") {
          await rm(f.input.installRecordFile);
          await mkdir(f.input.installRecordFile);
        }
      }),
    );
    // Then the backup is restored and a failure receipt is finalized.
    expect(moves).toEqual(
      failure === "replacement"
        ? [[f.input.stagedBinaryPath, f.input.executablePath]]
        : [
            [f.input.stagedBinaryPath, f.input.executablePath],
            [f.input.backupPath, f.input.executablePath],
          ],
    );
    expect(await Bun.file(f.input.executablePath).text()).toBe("old");
    if (failure === "replacement") expect(await Bun.file(f.input.installRecordFile).text()).toBe(before);
    const coreFailure = (await Effect.runPromise(f.handoff.consumeDeferred(f.input.token)))?.coreFailure;
    expect(coreFailure?.tag).toBe(
      failure === "replacement" ? "UpdatePermissionError" : "InstallOwnershipError",
    );
    // The receipt is all the next command sees, so it must name the move that failed.
    if (failure === "replacement") {
      expect(coreFailure?.message).toContain(`${f.input.stagedBinaryPath} to ${f.input.executablePath}`);
    }
  },
);

test("reports the original failure and the retained backup when rollback also fails", async () => {
  const f = await fixture();
  await Effect.runPromise(
    runWindowsReplacement(f.input, f.handoff, async (from, to) => {
      if (from === f.input.backupPath) throw new Error("restore failed");
      await rename(from, to);
      if (from === f.input.stagedBinaryPath) {
        await rm(f.input.installRecordFile);
        await mkdir(f.input.installRecordFile);
      }
    }),
  );
  const coreFailure = (await Effect.runPromise(f.handoff.consumeDeferred(f.input.token)))?.coreFailure;
  expect(coreFailure?.message).toMatch(/failed \(.+\) and its backup could not be restored/u);
  expect(coreFailure?.remediation).toContain(`restore ${f.input.backupPath} to ${f.input.executablePath}`);
  expect(await Bun.file(f.input.backupPath).text()).toBe("old");
});

test("holds the mutation lock through replacement and makes the outcome available exactly once", async () => {
  const f = await fixture();
  expect(await Effect.runPromise(f.handoff.consumeDeferred(f.input.token))).toBeUndefined();
  let moves = 0;
  const lockPath = pluginMutationSentinel(f.input.precondition.pluginsRoot);
  await Effect.runPromise(
    runWindowsReplacement(f.input, f.handoff, async (from, to) => {
      expect(await Bun.file(lockPath).exists()).toBe(true);
      moves += 1;
      await rename(from, to);
    }),
  );
  expect(moves).toBe(1);
  const lock = Bun.file(lockPath);
  expect(await lock.exists()).toBe(process.platform === "win32");
  if (process.platform === "win32") expect(await lock.text()).toBe("");
  expect(await Bun.file(f.input.executablePath).text()).toBe("new");
  expect(await Bun.file(f.input.backupPath).text()).toBe("old");
  expect((await Effect.runPromise(f.handoff.consumeDeferred(f.input.token)))?.updatedCore).toBe(true);
  expect(await Effect.runPromise(f.handoff.consumeDeferred(f.input.token))).toBeUndefined();
});

test("a competing lock participant cannot mutate between validation and replacement", async () => {
  const f = await fixture();
  const waiting = Deferred.makeUnsafe<void>();
  let mutated = false;
  let competitor: Promise<void> | undefined;
  const lockPath = pluginMutationSentinel(f.input.precondition.pluginsRoot);
  await Effect.runPromise(
    runWindowsReplacement(f.input, f.handoff, async (from, to) => {
      if (from === f.input.stagedBinaryPath) {
        competitor = Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const privateFileAccess = yield* PrivateFileAccessService;
              yield* acquireAdvisoryLockAt(lockPath, "plugin:add", {
                privateFileAccess,
                wait: "operation",
                timeoutMs: 30_000,
              });
              const executable = yield* Effect.promise(() => Bun.file(f.input.executablePath).text());
              expect(executable).toBe("new");
              yield* Effect.promise(async () => {
                await writeFile(
                  join(f.input.precondition.pluginsRoot, "registry.json"),
                  "competing mutation",
                );
                mutated = true;
              });
            }),
          ).pipe(
            Effect.provide([eventLayer, PrivateFileAccessService.layer]),
            Effect.provideService(EventPublicationObserver, (event) =>
              event._tag === "lock.wait" ? Deferred.succeed(waiting, undefined) : Effect.void,
            ),
            Effect.timeout("4 seconds"),
          ),
        );
        await Promise.race([
          competitor,
          Effect.runPromise(Deferred.await(waiting).pipe(Effect.timeout("3 seconds"))),
        ]);
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

test("a plugin mutation lock failure leaves the existing binary in place and records remediation", async () => {
  // A directory at the sentinel path can never be locked, so acquisition fails at once.
  const f = await fixture();
  await mkdir(pluginMutationSentinel(f.input.precondition.pluginsRoot));
  await Effect.runPromise(runWindowsReplacement(f.input, f.handoff));
  expect(await Bun.file(f.input.executablePath).text()).toBe("old");
  expect(await Bun.file(f.input.stagedBinaryPath).text()).toBe("new");
  const receipt = await Effect.runPromise(f.handoff.consumeDeferred(f.input.token));
  expect(receipt?.hasFailures).toBe(true);
  expect(receipt?.coreFailure?.message).toMatch(/lock|plugin mutation/i);
  expect(receipt?.updatedPlugins).toEqual(f.result.updatedPlugins);
});
