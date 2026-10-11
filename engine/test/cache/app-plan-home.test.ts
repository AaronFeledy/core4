import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { deriveAppPlanCacheKey, readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import * as AppCacheService from "../../src/cache/service.ts";

for (const hostHome of ["/home/first", "/home/second"]) {
  test(`reads the cached plan only when explicit hostHome stays /home/first (${hostHome})`, async () => {
    // Given
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-home-key-"));
    const input = {
      appRoot: "/workspace/home-key",
      landofile: { name: "home-key" },
      pluginManifests: [],
      planningRuntime: "fixed",
      hostHome: "/home/first",
    };
    const plan: AppPlan = {
      id: AppId.make("home-key"),
      name: "home-key",
      slug: "home-key",
      root: AbsolutePath.make(input.appRoot),
      provider: ProviderId.make("lando"),
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "test", runtime: 4 },
    };
    const location = { cacheRoot, appRoot: input.appRoot, appName: plan.name };
    try {
      await Effect.runPromise(
        writeCachedAppPlan({ ...location, key: deriveAppPlanCacheKey(input), plan }).pipe(
          Effect.provide(AppCacheService.layer),
        ),
      );
      // When
      const nextInput = { ...input, hostHome };
      const cached = await Effect.runPromise(
        readCachedAppPlan({ ...location, key: deriveAppPlanCacheKey(nextInput) }),
      );
      // Then
      expect(cached).toEqual(hostHome === input.hostHome ? plan : null);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
}

for (const appName of ["global", "user-home"]) {
  for (const changeHome of [false, true]) {
    test(`${appName} planner ${changeHome ? "rebuilds tilde mounts when HOME changes" : "hits cache when HOME is unchanged"}`, async () => {
      // Given: HOME changes happen only in a child, never in the test runner.
      const fixture = join(import.meta.dir, "fixtures", "app-plan-home.ts");
      const root = await realpath(await mkdtemp(join(tmpdir(), "lando-planner-home-")));
      await mkdir(join(root, "app"));
      try {
        for (const first of [true, false]) {
          const home = join(root, !first && changeHome ? "second-home" : "first-home");
          // When
          const child = Bun.spawn([process.execPath, fixture, appName, String(first || changeHome)], {
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              LANDO_USER_CACHE_ROOT: join(root, "cache"),
              LANDO_USER_DATA_ROOT: join(root, "data"),
            },
            cwd: join(root, "app"),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          // Then: the child checks real planner output and persistent cache reuse.
          expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
