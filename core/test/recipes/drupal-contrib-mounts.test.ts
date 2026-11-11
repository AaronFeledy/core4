import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { makeLandoPaths } from "@lando/paths";
import { ServiceName, effectiveExcludes, landoServiceStorageName, serviceAppMount } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { previewBuiltinRecipe } from "../_support/recipe-output.ts";

const SHADOW_INCLUDES = ["vendor", "node_modules", "tmp"] as const;

const planContribApp = async (name: string) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), `lando-drupal-contrib-${name}-`)));
  try {
    const preview = await previewBuiltinRecipe("drupal-contrib", name, { project: "example" });
    const compiled = await Effect.runPromise(
      loadAuthoredDocuments([{ file: join(root, ".lando.yml"), value: Bun.YAML.parse(preview.text) }], {
        appRoot: root,
        file: join(root, ".lando.yml"),
      }),
    );
    const planner = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          FileSyncResolver.layerWithEngine(TestFileSyncEngine, { platform: ["linux"] }),
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
        ),
      ),
    );
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (service) => service.plan(compiled, TestRuntimeProvider.capabilities)).pipe(
        Effect.provide(planner),
      ),
    );
    const appserver = plan.services[ServiceName.make("appserver")];
    if (appserver === undefined) throw new Error("Expected Drupal contrib appserver");
    return { appserver, name };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("plans a per-app prefixed /app store and no vendor, node_modules, or tmp shadows", async () => {
  const first = await planContribApp("contrib-alpha");
  const second = await planContribApp("contrib-beta");
  const stores: string[] = [];

  for (const { appserver, name } of [first, second]) {
    const appVolume = appserver.mounts.find((mount) => mount.type === "volume" && mount.target === "/app");
    expect(appVolume?.type).toBe("volume");
    if (appVolume === undefined || appVolume.type !== "volume") {
      throw new Error("Expected Drupal contrib /app data store");
    }
    expect(appVolume.store).toBe(landoServiceStorageName(name, "appserver", "/app"));
    expect(appVolume.store).not.toBe("app");
    stores.push(appVolume.store);

    const appMount = serviceAppMount(appserver);
    if (appMount === undefined) throw new Error("Expected Drupal contrib app mount");
    expect(appMount.includes).toEqual([...SHADOW_INCLUDES]);
    for (const shadow of SHADOW_INCLUDES) {
      expect(effectiveExcludes(appMount)).not.toContain(shadow);
      expect(
        appserver.mounts.some(
          (mount) => mount.type === "volume" && mount.target === `${appMount.target}/${shadow}`,
        ),
      ).toBe(false);
    }
  }

  expect(stores).toHaveLength(2);
  expect(stores[0]).not.toBe(stores[1]);
});
