import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect } from "effect";
import { deriveAppPlanCacheKey } from "../../src/cache/app-plan.ts";
import {
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { resolveAppIdentity } from "../../src/planner/app-identity.ts";
import { clearAppDataIdentity, recordAppDataIdentity } from "../../src/planner/data-identity.ts";

test("tooling becomes stale when the folder record is created or cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-data-tooling-"));
  const cacheRoot = join(root, "cache");
  const identity = await Effect.runPromise(resolveAppIdentity(root));
  const options = { cwd: root, cacheRoot };
  try {
    await writeFile(join(root, ".lando.yml"), "name: renamed\nruntime: 4\n");
    const write = () =>
      Effect.runPromise(
        writeAppCommandCacheStrict({ ...options, landofile: { name: "renamed" }, entries: [] }),
      );
    const read = () => Effect.runPromise(readAppCommandCacheForCwdDetailed(options));
    await write();
    expect((await read()).status).toBe("fresh");

    await Effect.runPromise(
      recordAppDataIdentity(identity, "original").pipe(Effect.provide(DiskStateStore.layer)),
    );
    expect(await read()).toMatchObject({ status: "stale", staleReason: "source" });
    await write();
    expect((await read()).status).toBe("fresh");

    await Effect.runPromise(clearAppDataIdentity(identity).pipe(Effect.provide(DiskStateStore.layer)));
    expect(await read()).toMatchObject({ status: "stale", staleReason: "source" });
  } finally {
    await Effect.runPromise(clearAppDataIdentity(identity).pipe(Effect.provide(DiskStateStore.layer)));
    await rm(root, { recursive: true, force: true });
  }
});

test("plan cache keys distinguish the raw data name and app kind", () => {
  const input = {
    appRoot: "/app",
    hostProvider: "test",
    landofile: { name: "current" },
    pluginManifests: [],
  };
  const user = deriveAppPlanCacheKey({ ...input, dataName: "Original", kind: "user" });
  expect(deriveAppPlanCacheKey({ ...input, dataName: "original", kind: "user" })).not.toBe(user);
  expect(deriveAppPlanCacheKey({ ...input, dataName: "Original", kind: "scratch" })).not.toBe(user);
  expect(deriveAppPlanCacheKey({ ...input, dataName: "Original", kind: "global" })).not.toBe(user);
});
