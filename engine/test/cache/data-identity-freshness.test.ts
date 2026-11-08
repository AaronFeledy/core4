import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import { deriveAppPlanCacheKey } from "../../src/cache/app-plan.ts";
import {
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { resolveAppIdentity } from "../../src/planner/app-identity.ts";
import { clearAppDataIdentity, recordAppDataIdentity } from "../../src/planner/data-identity.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test.each(["default", "paths", "roots", "state-store"] as const)(
  "tooling follows %s identity records when created or cleared",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-data-tooling-"));
    const cacheRoot = join(root, "cache");
    const identity = await Effect.runPromise(resolveAppIdentity(root));
    const injected = makeLandoPaths({
      userDataRoot: join(root, "injected-data"),
      env: {},
      sources: { user: false, env: false },
    });
    // "roots" mirrors a CLI invocation: compilation gets the invocation's store, cold reads get only its roots.
    const options =
      mode === "roots" ? { cwd: root, cacheRoot, roots: injected.roots } : { cwd: root, cacheRoot };
    const paths = Layer.succeed(PathsService, injected);
    const store =
      mode === "state-store"
        ? makeTestStateStore().layer
        : mode === "roots"
          ? DiskStateStore.layerAt(injected.roots)
          : DiskStateStore.layer.pipe(Layer.provide(mode === "paths" ? paths : Layer.empty));
    const reader = mode === "state-store" ? store : mode === "paths" ? paths : Layer.empty;
    const writer = mode === "roots" ? store : reader;
    try {
      await writeFile(join(root, ".lando.yml"), "name: renamed\nruntime: 4\n");
      const write = () =>
        Effect.runPromise(
          writeAppCommandCacheStrict({ ...options, landofile: { name: "renamed" }, entries: [] }).pipe(
            Effect.provide(writer),
          ),
        );
      const read = () =>
        Effect.runPromise(readAppCommandCacheForCwdDetailed(options).pipe(Effect.provide(reader)));
      await write();
      expect((await read()).status).toBe("fresh");

      await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store)));
      expect(await read()).toMatchObject({ status: "stale", staleReason: "source" });
      await write();
      expect((await read()).status).toBe("fresh");

      await Effect.runPromise(clearAppDataIdentity(identity).pipe(Effect.provide(store)));
      expect(await read()).toMatchObject({ status: "stale", staleReason: "source" });
    } finally {
      await Effect.runPromise(clearAppDataIdentity(identity).pipe(Effect.provide(store)));
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
