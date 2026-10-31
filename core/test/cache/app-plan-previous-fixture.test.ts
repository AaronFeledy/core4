import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import {
  APP_PLAN_CACHE_HEADER_BYTES,
  APP_PLAN_CACHE_MAGIC,
  readCachedAppPlan,
} from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";

test.each([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 35, 38, 39, 41, 44])(
  "current app-plan cache rejects the persisted revision %i fixture",
  async (revision) => {
    // Given intact versioned bytes at the real cache path.
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-previous-"));
    try {
      const path = appPlanCachePath(cacheRoot, "fixture-app", "/workspace/fixture-app");
      const fixture = await readFile(
        join(import.meta.dirname, `fixtures/binary-cache/app-plan-v${revision}.bin`),
      );
      expect(fixture.subarray(0, 4)).toEqual(APP_PLAN_CACHE_MAGIC);
      expect(fixture.readBigUInt64BE(4)).toBe(BigInt(revision));
      expect(fixture.subarray(12, APP_PLAN_CACHE_HEADER_BYTES)).toEqual(
        createHash("sha256").update(fixture.subarray(APP_PLAN_CACHE_HEADER_BYTES)).digest(),
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, fixture);

      // When the current reader loads that persisted entry.
      const cached = await Effect.runPromise(
        readCachedAppPlan({
          cacheRoot,
          appName: "fixture-app",
          appRoot: "/workspace/fixture-app",
          key: "fixture-key",
        }),
      );

      // Then historical desired-plan bytes stay intact and cannot be reused.
      expect(cached).toBeNull();
      expect(await readFile(path)).toEqual(fixture);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  },
);
