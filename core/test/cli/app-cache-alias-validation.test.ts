import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer } from "effect";

import { type AppCacheRefreshResult, refreshAppCache } from "@lando/core/cli/operations";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PluginName,
  type ProviderCapabilities,
  ProviderId,
} from "@lando/core/schema";
import { AppPlanner, LandofileService, PluginRegistry, RuntimeProviderRegistry } from "@lando/core/services";
import { readFreshAppCommandCacheForCwd } from "@lando/engine/cache/command-index-writer";
import { appCommandCachePath, appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { resolveToolingRoute } from "../../src/cli/tooling-router.ts";

const providerId = ProviderId.make("lando");
const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
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
  architectureEmulation: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const withRefreshFixture = async <T>(
  commandAliases: NonNullable<LandofileShape["commandAliases"]>,
  run: (fixture: {
    readonly cachePath: string;
    readonly toolingCachePath: string;
    readonly root: string;
    readonly cacheRoot: string;
    readonly refresh: Effect.Effect<AppCacheRefreshResult, unknown>;
  }) => Promise<T>,
  scripts: ReadonlyArray<string> = [],
): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-app-cache-aliases-")));
  const cacheRoot = join(root, "cache");
  const landofile = {
    name: "alias-refresh",
    services: {},
    tooling: { hello: { cmds: ["echo hi"] } },
    commandAliases,
  } satisfies LandofileShape;
  const plan: AppPlan = attachEffectiveTooling(
    {
      id: AppId.make("alias-refresh"),
      name: "alias-refresh",
      slug: "alias-refresh",
      root: AbsolutePath.make(root),
      provider: providerId,
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-08-15T00:00:00Z"),
        source: "app-cache-alias-validation.test",
        runtime: 4,
      },
      extensions: {},
    },
    landofile.tooling,
  );
  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.succeed(landofile) })),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([
          {
            name: PluginName.make("@lando/seed"),
            version: "0.0.0",
            api: 4,
            bootstrap: "app",
            contributes: { commands: ["db:seed"] },
          },
        ]),
        load: () => Effect.die("plugin load must not run"),
        loadServiceType: () => Effect.die("service type load must not run"),
        loadServiceFeature: () => Effect.die("service feature load must not run"),
        loadAppFeature: () => Effect.die("app feature load must not run"),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.die("provider must not be selected"),
      }),
    ),
  );

  try {
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: alias-refresh\n");
    for (const script of scripts) {
      const path = join(root, ".lando/scripts", script);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "# ---\n# desc: Script task\n# ---\necho script\n");
    }
    const refresh = refreshAppCache({ cwd: root, cacheRoot }).pipe(Effect.provide(layer));
    return await run({
      cachePath: appCommandCachePath(cacheRoot, landofile.name, root),
      toolingCachePath: appToolingCompilationCachePath(cacheRoot, root),
      root,
      cacheRoot,
      refresh,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("app cache refresh rejects canonical alias collisions before writing", async () => {
  await withRefreshFixture({ custom: { "app:hello": "app:start" } }, async ({ cachePath, refresh }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(refresh));

    // Then
    expect(error).toBeInstanceOf(CommandAliasConflictError);
    expect(error).toMatchObject({ alias: "app:hello", reservedFor: "app:hello" });
    expect(await Bun.file(cachePath).exists()).toBe(false);
  });
});

test.each(["info", "version", "help", "run", "scratch", "cache/refresh"])(
  "app cache refresh rejects the script %s before writing command caches",
  async (name) => {
    // Given
    await withRefreshFixture(
      {},
      async ({ cachePath, toolingCachePath, refresh }) => {
        // When
        const error = await Effect.runPromise(Effect.flip(refresh));
        // Then
        expect(error).toBeInstanceOf(CommandAliasConflictError);
        expect(await Bun.file(cachePath).exists()).toBe(false);
        expect(await Bun.file(toolingCachePath).exists()).toBe(false);
      },
      [`${name}.bun.sh`],
    );
  },
);

test.each([{ enabled: false }, { disabled: ["info"] }, { custom: { info: "app:hello" } }])(
  "canonical script collisions still fail under alias policy %j",
  async (policy) => {
    // Given
    await withRefreshFixture(
      policy,
      async ({ refresh }) => {
        // When
        const error = await Effect.runPromise(Effect.flip(refresh));
        // Then
        expect(error).toMatchObject({
          _tag: "CommandAliasConflictError",
          alias: "app:info",
          reservedFor: "app:info",
        });
      },
      ["info.bun.sh"],
    );
  },
);

test("valid nested scripts and Landofile precedence survive refresh", async () => {
  // Given
  await withRefreshFixture(
    {},
    async ({ refresh, root, cacheRoot }) => {
      // When
      const result = await Effect.runPromise(refresh);
      const cache = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: root, cacheRoot }));
      const route = await Effect.runPromise(resolveToolingRoute("app:db:seed", { cwd: root, cacheRoot }));
      const bare = await Effect.runPromise(resolveToolingRoute("db:seed", { cwd: root, cacheRoot }));
      // Then
      expect(result.commandsCompiled).toBe(4);
      expect(cache?.entries.map(({ id }) => id)).toEqual([
        "app:build",
        "app:db:seed",
        "app:env:init",
        "app:hello",
      ]);
      expect(cache?.entries.find(({ id }) => id === "app:hello")?.source).toBeUndefined();
      expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:db:seed" });
      expect(bare).toEqual({ _tag: "not-tooling" });
    },
    ["build.bun.sh", "db/seed.bun.sh", "env/init.bun.sh", "hello.bun.sh"],
  );
});

test.each([{ enabled: false }, { disabled: ["version"] }, { custom: { version: "app:version" } }])(
  "noncanonical script alias respects alias policy %j",
  async (policy) => {
    // Given
    await withRefreshFixture(
      policy,
      async ({ refresh, root, cacheRoot }) => {
        // When
        const result = await Effect.runPromise(refresh);
        const route = await Effect.runPromise(resolveToolingRoute("app:version", { cwd: root, cacheRoot }));
        // Then
        expect(result.commandsCompiled).toBe(2);
        expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:version" });
      },
      ["version.bun.sh"],
    );
  },
);

test("app cache refresh rejects unknown alias targets before writing", async () => {
  await withRefreshFixture({ custom: { hi: "app:missing" } }, async ({ cachePath, refresh }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(refresh));

    // Then
    expect(error).toBeInstanceOf(CommandAliasTargetError);
    expect(error).toMatchObject({ alias: "hi", target: "app:missing" });
    expect(await Bun.file(cachePath).exists()).toBe(false);
  });
});

test.each([
  ["unknown targets", { hi: "app:missing" }],
  ["canonical collisions", { "app:hello": "app:start" }],
] as const)("app cache refresh ignores dormant %s when aliases are disabled", async (_case, custom) => {
  await withRefreshFixture({ enabled: false, custom }, async ({ cachePath, refresh }) => {
    // Given / When
    const result = await Effect.runPromise(refresh);

    // Then
    expect(result.commandsCompiled).toBe(1);
    expect(await Bun.file(cachePath).exists()).toBe(true);
  });
});

test("app cache refresh accepts built-in and compiled tooling alias targets", async () => {
  await withRefreshFixture(
    { custom: { launch: "app:start", greet: "app:hello" } },
    async ({ cachePath, refresh }) => {
      // Given / When
      const result = await Effect.runPromise(refresh);

      // Then
      expect(result.commandsCompiled).toBe(1);
      expect(await Bun.file(cachePath).exists()).toBe(true);
    },
  );
});
