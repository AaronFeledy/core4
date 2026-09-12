import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { Effect } from "effect";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeUpdateHandoff } from "../../src/update/handoff.ts";
import { runWindowsReplacement } from "../../src/update/windows.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-windows-replace-"));
  roots.push(root);
  const pluginsRoot = join(root, "plugins");
  await mkdir(pluginsRoot);
  const executablePath = join(root, "lando.exe");
  const stagedBinaryPath = join(root, "candidate.exe");
  await writeFile(executablePath, "old");
  await writeFile(stagedBinaryPath, "new");
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
    stagedBinaryPath,
    backupPath: `${executablePath}.bak`,
    attemptedVersion: "4.2.0",
    manualFallback: "retry",
    token,
    precondition: { pluginsRoot, currentCoreVersion: "4.1.0", targetCoreVersion: "4.2.0" },
  };
  return { root, input, store, handoff, result };
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
