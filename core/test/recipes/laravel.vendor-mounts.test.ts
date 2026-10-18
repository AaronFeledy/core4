import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, ServiceName, appMountSyncIgnores } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { previewBuiltinRecipe } from "../_support/recipe-output.ts";

test.each([
  { worker: false, slow: false },
  { worker: true, slow: false },
  { worker: false, slow: true },
  { worker: true, slow: true },
])("Laravel vendor mounts when %j", async ({ worker, slow }) => {
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
        service.plan(rememberLandofileAppRoot(landofile, root), {
          ...TestRuntimeProvider.capabilities,
          bindMountPerformance: slow ? "slow" : "native",
        }),
      ).pipe(Effect.provide(planner)),
    );

    // Then worker mode shares host vendor, while the default retains its vendor shadow.
    for (const name of worker ? ["appserver", "worker"] : ["appserver"]) {
      const service = plan.services[ServiceName.make(name)];
      expect(service?.storage.filter(({ target }) => target === "/app/vendor")).toHaveLength(worker ? 0 : 1);
      expect(service?.appMount).toMatchObject({ source: root, target: "/app" });
      expect(service?.mounts.some((mount) => mount.type === "bind" && mount.source === root)).toBe(false);
      if (slow) {
        if (service === undefined) throw new Error("Expected Laravel service");
        const ignores = plan.fileSync.find(({ session }) => session.service === name)?.session.excludes;
        expect(ignores).toEqual(appMountSyncIgnores(service));
        expect(ignores?.includes("vendor")).toBe(!worker);
      }
    }

    // Then npm runs in a private Node service on the same project bind in either mode.
    expect(landofile.tooling?.npm).toMatchObject({ service: "node", cmds: ["npm"] });
    const node = plan.services[ServiceName.make("node")];
    expect(node).toMatchObject({
      type: "node:22",
      artifact: { kind: "ref", ref: "node:22" },
      primary: false,
      workingDirectory: "/app",
      endpoints: [],
      routes: [],
    });
    expect(landofile.services?.[ServiceName.make("node")]).toEqual({
      type: "node:22",
      primary: false,
      endpoints: [],
    });
    expect(node?.appMount).toMatchObject({ source: root, target: "/app" });
    expect(node?.healthcheck).toBeUndefined();
    expect(node?.command).toEqual([
      "node",
      "-e",
      'process.on("SIGTERM",()=>process.exit(0));process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},2147483647);',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
