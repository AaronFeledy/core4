import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appCommandCachePath, pluginCommandCachePath } from "@lando/engine/cache/paths";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { PluginManifest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { refreshAppCache } from "../../src/cli/commands/app-cache-refresh.ts";
import { type LandoRuntimeOptions, makeLandoRuntime } from "../../src/runtime/layer.ts";
import { makeFixture } from "./subprocess-support.ts";

const fixtureFor = async (event: string) => {
  const fixture = await makeFixture("observer-cache");
  const userConfRoot = fixture.env.LANDO_USER_CONF_ROOT;
  const userDataRoot = fixture.env.LANDO_USER_DATA_ROOT;
  if (userConfRoot === undefined || userDataRoot === undefined) {
    throw new Error("App-cache subscriber fixture requires isolated config and data roots");
  }
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/deferred-observer",
    version: "1.0.0",
    api: 4,
    subscribers: [{ id: "exact", selectors: [{ event }], module: "./never-loaded.ts" }],
  });
  await writeFile(
    join(fixture.root, ".lando.yml"),
    "name: observer-cache\nservices: {}\ntooling:\n  hello:\n    cmd: echo hi\n  db_reset:\n    cmd: echo reset\n  Release.v2:\n    cmd: echo release\n",
  );
  const layer = makeLandoRuntime({
    bootstrap: "app",
    cwd: fixture.root,
    plugins: {
      policy: {
        mode: "bundled-only",
        manifests: [
          {
            manifest,
            entry: {
              name: manifest.name,
              manifest,
              subscriberFactoryLoaders: new Map([
                [
                  "exact",
                  async () => {
                    throw new Error("Cache validation must not load subscriber factories");
                  },
                ],
              ]),
            },
          },
        ],
      },
    },
    configSources: { user: false, env: false },
    config: {
      userConfRoot,
      userDataRoot,
      userCacheRoot: fixture.cacheRoot,
    },
  } satisfies LandoRuntimeOptions & { readonly bootstrap: "app" });
  return {
    ...fixture,
    appCache: appCommandCachePath(fixture.cacheRoot, "observer-cache", fixture.root),
    pluginCache: pluginCommandCachePath(fixture.cacheRoot),
    refresh: withAppDiscovery(
      fixture.root,
      refreshAppCache({ cwd: fixture.root, cacheRoot: fixture.cacheRoot }).pipe(Effect.provide(layer)),
    ),
  };
};

test("explicit full compilation rejects a deferred missing selector before publishing command caches", async () => {
  // Given: registration accepts a deferred app target, and the command caches already hold previous bytes.
  const fixture = await fixtureFor("cli-app:missing-run");
  try {
    await mkdir(join(fixture.appCache, ".."), { recursive: true });
    await writeFile(fixture.appCache, "previous-app-cache");
    await writeFile(fixture.pluginCache, "previous-plugin-cache");
    // When: cache refresh deliberately compiles the full app catalog.
    const error = await Effect.runPromise(Effect.flip(fixture.refresh));
    // Then: the exact selector is rejected and neither cache is replaced.
    expect(error).toMatchObject({ _tag: "PluginManifestError", remediation: expect.any(String) });
    expect(error.message).toContain("cli-app:missing-run");
    expect(await Bun.file(fixture.appCache).text()).toBe("previous-app-cache");
    expect(await Bun.file(fixture.pluginCache).text()).toBe("previous-plugin-cache");
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test.each([
  "app:hello",
  "app:start",
  "app:db:seed",
  "app:db_reset",
  "app:123",
  "app:_private:123_reset",
  "app:Release.v2",
])(
  "authoritative refresh accepts %s from compiled or static metadata",
  async (id) => {
    // Given: a deferred selector and a nested script alongside Landofile tooling.
    const fixture = await fixtureFor(`cli-${id}-run`);
    try {
      await mkdir(join(fixture.root, ".lando/scripts/db"), { recursive: true });
      await writeFile(
        join(fixture.root, ".lando/scripts/db/seed.bun.sh"),
        "# ---\n# desc: Seed\n# ---\necho seed\n",
      );
      await mkdir(join(fixture.root, ".lando/scripts/_private"), { recursive: true });
      for (const name of ["123", "_private/123_reset"]) {
        await writeFile(
          join(fixture.root, `.lando/scripts/${name}.bun.sh`),
          "# ---\n# desc: Script\n# ---\necho script\n",
        );
      }
      // When: explicit cache refresh acquires the complete app-command inventory.
      const result = await Effect.runPromise(fixture.refresh);
      // Then: validated selectors allow command-cache publication without loading their handlers.
      expect(result.commandsCompiled).toBe(6);
      expect(result.appCommandCachePath).toBe(fixture.appCache);
      expect(result.pluginCommandCachePath).toBe(fixture.pluginCache);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test("failed script acquisition does not masquerade as an authoritative empty app catalog", async () => {
  // Given: a deferred selector for a script whose metadata cannot compile.
  const fixture = await fixtureFor("cli-app:broken-run");
  try {
    await mkdir(join(fixture.root, ".lando/scripts"), { recursive: true });
    await writeFile(join(fixture.root, ".lando/scripts/broken.bun.sh"), "");
    // When: explicit refresh tries to acquire the complete inventory.
    const error = await Effect.runPromise(Effect.flip(fixture.refresh));
    // Then: acquisition failure is retained rather than reporting a false unknown selector.
    expect(error).toMatchObject({ _tag: "BunShellScriptEmptyError" });
    expect(await Bun.file(fixture.appCache).exists()).toBe(false);
    expect(await Bun.file(fixture.pluginCache).exists()).toBe(false);
  } finally {
    await fixture.cleanup();
  }
}, 30_000);
