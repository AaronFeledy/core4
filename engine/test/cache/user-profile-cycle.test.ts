import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { Effect, Layer, Schema } from "effect";

import { getLandofileIncludeSources } from "@lando/landofile/include-provenance";
import { resolveLandofileIncludes } from "@lando/landofile/includes";
import { ServiceName } from "@lando/sdk/schema";
import { AppPlanner, CacheService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { APP_PLAN_CACHE_HEADER_BYTES } from "../../src/cache/app-plan.ts";
import {
  readFreshAppCommandCacheForCwd,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import { CacheServiceLive } from "../../src/cache/service.ts";
import { landofileRuntimeInputs } from "../../src/composition.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

test("recomputes profile identities through edit, deletion, and byte-identical restoration", async () => {
  // Given: real include resolution, planner, and disk caches, isolated from host roots.
  const root = await mkdtemp(join(tmpdir(), "lando-profile-cycle-"));
  const appRoot = join(root, "app");
  const includesRoot = join(root, "includes");
  const cacheRoot = join(root, "cache");
  const profilePath = join(includesRoot, "profile.yml");
  const original =
    "services:\n  web:\n    type: compose\n    image: alpine:3.21\n    home: false\n    environment:\n      ORIGIN: original\n";
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  let writes = 0;
  const cache = Layer.effect(
    CacheService,
    Effect.map(CacheService, (service) => ({
      ...service,
      writeAtomic: (...args: Parameters<typeof service.writeAtomic>) =>
        service.writeAtomic(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              writes += 1;
            }),
          ),
        ),
    })),
  ).pipe(Layer.provide(CacheServiceLive));
  const plannerLayer = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, FileSystemLive, cache)),
  );
  const load = () =>
    resolveLandofileIncludes({
      landofile: { name: "profile-cycle", includes: ["user:profile.yml"] },
      appRoot,
      cacheRoot,
      ports: { ...landofileRuntimeInputs().ports, resolveUserIncludesDir: () => includesRoot },
      stateStore: makeStateStore({
        privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      }),
    });
  const plan = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const landofile = yield* load();
        const planner = yield* AppPlanner;
        return { landofile, plan: yield* planner.plan(landofile, TestRuntimeProvider.capabilities) };
      }).pipe(Effect.provide(plannerLayer)),
    );
  const commands = () => Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));
  const cacheIdentity = async () =>
    Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
      deserialize(
        (await readFile(appPlanCachePath(cacheRoot, "profile-cycle", appRoot))).subarray(
          APP_PLAN_CACHE_HEADER_BYTES,
        ),
      ),
    ).key;
  try {
    await mkdir(appRoot, { recursive: true });
    await mkdir(includesRoot, { recursive: true });
    await writeFile(join(appRoot, ".lando.yml"), "name: profile-cycle\nincludes:\n  - user:profile.yml\n");
    await writeFile(profilePath, original);
    const first = await plan();
    const firstKey = await cacheIdentity();
    expect(writes).toBe(1);
    expect(getLandofileIncludeSources(first.landofile)).toEqual([
      { id: "user:profile.yml", sha256: createHash("sha256").update(original).digest("hex") },
    ]);
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        landofile: first.landofile,
        entries: [{ id: "app:check", summary: "Check", hidden: false, service: "web" }],
        cwd: appRoot,
        cacheRoot,
      }),
    );
    const firstCommands = await commands();
    expect(firstCommands).not.toBeNull();
    expect((await plan()).plan).toEqual(first.plan);
    expect(writes).toBe(1);

    // When: the referenced file is edited, deleted, then restored without touching the app file.
    const edited = original.replace("ORIGIN: original", "ORIGIN: modified");
    await writeFile(profilePath, edited);
    expect(await commands()).toBeNull();
    const changed = await plan();
    expect(writes).toBe(2);
    expect(await cacheIdentity()).not.toBe(firstKey);
    expect(changed.plan.services[ServiceName.make("web")]?.environment.ORIGIN).toBe("modified");
    expect(getLandofileIncludeSources(changed.landofile)).toEqual([
      { id: "user:profile.yml", sha256: createHash("sha256").update(edited).digest("hex") },
    ]);
    await rm(profilePath);
    expect(await commands()).toBeNull();
    await expect(plan()).rejects.toThrow();
    expect(writes).toBe(2); // Missing required profiles fail before a stale plan can be returned.
    await writeFile(profilePath, original);

    // Then: the retained command entry re-hits; the single-slot plan cache regains its original key.
    expect(await commands()).toEqual(firstCommands);
    const restored = await plan();
    expect(getLandofileIncludeSources(restored.landofile)).toEqual(
      getLandofileIncludeSources(first.landofile),
    );
    expect(await cacheIdentity()).toBe(firstKey);
    expect(restored.plan.services[ServiceName.make("web")]?.environment.ORIGIN).toBe("original");
    expect(writes).toBe(3); // The edited plan evicted the original single-slot entry.
    expect((await plan()).plan).toEqual(restored.plan);
    expect(writes).toBe(3); // Identical restored bytes now legitimately hit, not another recomputation.
  } finally {
    if (previousCache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCache;
    await rm(root, { recursive: true, force: true });
  }
});
