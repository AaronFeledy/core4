import { expect, test } from "bun:test";
import { rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { sourceRecords } from "../src/records.ts";
import { disposeTestSourceStore, makeTestSourceStore } from "../src/testing.ts";
import { emptyLockKeys, runGc } from "./gc-support.ts";

test.each(["npm", "ref", "root"] as const)("%s symlinks miss acquisition and fail GC", async (kind) => {
  const fixture = await makeTestSourceStore();
  try {
    const records = sourceRecords(fixture.stateStore);
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        switch (kind) {
          case "npm": {
            const bucket = yield* records.npm("https://registry.test", "example", "1.0.0");
            yield* bucket.set({
              name: "example",
              version: "1.0.0",
              registry: "https://registry.test",
              sha256: "a".repeat(64),
            });
            return {
              path: bucket.path,
              hit: bucket.get.pipe(Effect.map((value) => value !== null)),
              exists: bucket.exists,
            };
          }
          case "ref": {
            const bucket = yield* records.ref("https://git.test/example", "main");
            yield* bucket.set({ commit: "a".repeat(40) });
            return {
              path: bucket.path,
              hit: bucket.get.pipe(Effect.map((value) => value !== null)),
              exists: bucket.exists,
            };
          }
          case "root": {
            const bucket = yield* records.root(join(fixture.root, "app", ".lando.lock.yml"));
            yield* bucket.set({ lockfile: "/app/.lando.lock.yml", updatedAt: 0 });
            return {
              path: bucket.path,
              hit: bucket.get.pipe(Effect.map((value) => value !== null)),
              exists: bucket.exists,
            };
          }
          default: {
            const exhaustive: never = kind;
            return exhaustive;
          }
        }
      }),
    );
    const target = join(fixture.root, "other-record");
    await rename(record.path, target);
    await symlink(target, record.path);

    expect(await Effect.runPromise(record.hit)).toBe(false);
    expect(await Effect.runPromise(record.exists)).toBe(false);
    const report = await runGc(fixture.store, { prune: true, olderThanMs: 0, readLockKeys: emptyLockKeys });
    expect(report.leftovers.filter((row) => row.outcome === "failed")).toMatchObject([
      { kind: kind === "npm" ? "npm-index" : kind, reason: "Source record is not a regular file." },
    ]);
    expect(report.totals.failed).toBe(1);
  } finally {
    await disposeTestSourceStore(fixture);
  }
});
