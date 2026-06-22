import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";

import { type AppPlan, type ProviderCapabilities, ProviderId } from "@lando/core/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape, ScratchAppService } from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { ScratchRegistryLive } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../src/scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../src/scratch-app/service.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const withTempEnv = async <T>(run: (roots: { readonly cacheRoot: string }) => Promise<T>): Promise<T> => {
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-recipe-cache-")));
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-recipe-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-recipe-conf-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-recipe-cwd-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const previousConfRoot = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.chdir(cwd);
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run({ cacheRoot });
  } finally {
    process.chdir(previousCwd);
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousCacheRoot === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousConfRoot === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConfRoot;
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
};

const die = (operation: string) =>
  Effect.dieMessage(`scratch recipe test provider should not call ${operation}`);

const makeScratchRecipeLayer = (appliedPlans: AppPlan[]) => {
  const provider: RuntimeProviderShape = {
    id: String(providerId),
    displayName: "Scratch Recipe Test Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true, message: "ready" }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () => die("buildArtifact"),
    pullArtifact: () => die("pullArtifact"),
    removeArtifact: () => Effect.void,
    apply: (plan) =>
      Effect.sync(() => {
        appliedPlans.push(plan);
        return { changed: true };
      }),
    start: () => die("start"),
    stop: () => die("stop"),
    restart: () => die("restart"),
    destroy: () => die("destroy"),
    exec: () => die("exec"),
    execStream: () => Stream.die("scratch recipe test provider should not call execStream"),
    run: () => die("run"),
    logs: () => Stream.empty,
    inspect: () => die("inspect"),
    list: () => Effect.succeed([]),
  };

  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const registryLive = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(provider),
  });
  const scratchDeps = Layer.mergeAll(
    FileSystemLive,
    LandofileServiceLive,
    plannerLive,
    registryLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
  );
  return Layer.mergeAll(scratchDeps, ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)));
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

describe("ScratchAppServiceLive recipe acquire", () => {
  test("renders a bundled recipe into the scratch root and plans under a fresh identity", async () => {
    await withTempEnv(async () => {
      const appliedPlans: AppPlan[] = [];
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "recipe", ref: "empty" },
              detached: true,
              nonInteractive: true,
            }),
          ),
        ).pipe(Effect.provide(makeScratchRecipeLayer(appliedPlans))),
      );

      expect(handle.id).toMatch(/^scratch-empty-[0-9a-f]{6}$/u);
      expect(appliedPlans).toHaveLength(1);
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch recipe acquire did not apply a plan");
      expect(String(appliedPlan.id)).toBe(handle.id);
      expect(appliedPlan.slug).toBe(handle.id);
      expect(appliedPlan.name).toBe(handle.id);
      expect(appliedPlan.root.endsWith(join("scratch", handle.id, "root"))).toBe(true);
      expect(handle.app).toEqual({ kind: "scratch", id: handle.id, root: appliedPlan.root });
      expect(await fileExists(join(appliedPlan.root, ".lando.yml"))).toBe(true);
      const rendered = await readFile(join(appliedPlan.root, ".lando.yml"), "utf8");
      expect(rendered).toContain(`name: ${handle.id}`);
    });
  });

  test("auto-answers recipe prompts from the answers map", async () => {
    await withTempEnv(async () => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "recipe", ref: "lamp" },
              detached: true,
              nonInteractive: true,
              answers: { php: "8.2" },
            }),
          ),
        ).pipe(Effect.provide(makeScratchRecipeLayer(appliedPlans))),
      );

      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch recipe acquire did not apply a plan");
      const rendered = await readFile(join(appliedPlan.root, ".lando.yml"), "utf8");
      expect(rendered).toContain("type: php:8.2");
      expect(rendered).not.toContain("type: php:8.3");
    });
  });

  test("--yes accepts recipe prompt defaults", async () => {
    await withTempEnv(async () => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({ source: { kind: "recipe", ref: "lamp" }, detached: true, yes: true }),
          ),
        ).pipe(Effect.provide(makeScratchRecipeLayer(appliedPlans))),
      );

      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch recipe acquire did not apply a plan");
      const rendered = await readFile(join(appliedPlan.root, ".lando.yml"), "utf8");
      expect(rendered).toContain("type: php:8.3");
    });
  });

  test("surfaces recipe prompt failures with answer remediation", async () => {
    await withTempEnv(async ({ cacheRoot }) => {
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "recipe", ref: "lamp" },
              detached: true,
              nonInteractive: true,
              answers: { php: "9.0" },
            }),
          ),
        ).pipe(Effect.provide(makeScratchRecipeLayer([])), Effect.either),
      );

      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left._tag).toBe("ScratchAppError");
        expect(outcome.left.message).toContain('recipe prompt "php"');
        expect(outcome.left.message).toContain('Invalid value for prompt "php"');
        expect(outcome.left.message).not.toContain("Unable to render the recipe into the scratch app root");
        expect(outcome.left.remediation).toBe(
          "Provide it with --answer php=<value> or --option php=<value>.",
        );
      }
      expect((await readdir(join(cacheRoot, "scratch"))).filter((entry) => entry !== "registry.bin")).toEqual(
        [],
      );
    });
  });

  test("maps an unknown recipe reference to ScratchSourceUnresolvedError", async () => {
    await withTempEnv(async ({ cacheRoot }) => {
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "recipe", ref: "definitely-not-a-recipe" },
              detached: true,
              nonInteractive: true,
            }),
          ),
        ).pipe(Effect.provide(makeScratchRecipeLayer([])), Effect.either),
      );

      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left._tag).toBe("ScratchSourceUnresolvedError");
        expect(outcome.left.remediation).toBe(
          "Verify the recipe reference and try again, e.g. `lando apps:scratch:start --from empty`.",
        );
      }
      expect((await readdir(join(cacheRoot, "scratch"))).filter((entry) => entry !== "registry.bin")).toEqual(
        [],
      );
    });
  });
});
