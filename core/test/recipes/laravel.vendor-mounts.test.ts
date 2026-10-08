import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { previewBuiltinRecipe } from "../_support/recipe-output.ts";

test.each([false, true])("Laravel vendor mounts when worker=%s", async (worker) => {
  // Given the generated Laravel config, not manually authored mount overrides.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-laravel-vendor-")));
  try {
    const preview = await previewBuiltinRecipe("laravel", "laravel-vendor", { worker });
    const landofile = Schema.decodeUnknownSync(LandofileShape)(Bun.YAML.parse(preview.text));
    const planner = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
        ),
      ),
    );

    // When the production planner resolves storage and app binds.
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (service) =>
        service.plan(rememberLandofileAppRoot(landofile, root), TestRuntimeProvider.capabilities),
      ).pipe(Effect.provide(planner)),
    );

    // Then worker mode shares host vendor, while the default retains its vendor shadow.
    for (const name of worker ? ["appserver", "worker"] : ["appserver"]) {
      const service = plan.services[ServiceName.make(name)];
      expect(service?.storage.filter(({ target }) => target === "/app/vendor")).toHaveLength(worker ? 0 : 1);
      expect(service?.mounts).toContainEqual(
        expect.objectContaining({ source: root, target: "/app", type: "bind" }),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
