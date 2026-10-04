import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { readCachedAppPlan } from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";

test("app-plan returns a cache miss when the persisted fixture is revision 17", async () => {
  // Given the unchanged previous-revision bytes at the real cache path.
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-previous-"));
  try {
    const path = appPlanCachePath(cacheRoot, "fixture-app", "/workspace/fixture-app");
    const fixture = await readFile(join(import.meta.dirname, "fixtures/binary-cache/app-plan-v17.bin"));
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

    // Then the entry is rejected rather than reused.
    expect(cached).toBeNull();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
