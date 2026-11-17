import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { DATA_TREE_OWNERSHIP_STEP_ID } from "../../src/planner/data-tree.ts";
import { serviceFeatureBuildSteps } from "../../src/planner/extensions.ts";
import { projectUserRenumberStepId } from "../../src/planner/project-user.ts";
import { resolveHostFacts } from "../../src/planner/service-types.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const host = resolveHostFacts();
const hostIsUsable = host !== undefined && host.uid !== "0" && host.gid !== "0";

const capabilities = {
  ...TestRuntimeProvider.capabilities,
  artifactBuild: true,
  projectUserMapping: "image-renumber" as const,
  bindOwnership: "host-ids" as const,
};

const plan = async (appRoot: string, landofile: LandofileShape) => {
  const planner = AppPlannerLayer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        PluginRegistryLayer.layer,
        BunFileSystem.layer,
        Layer.succeed(
          PathsService,
          makeLandoPaths({
            platform: "linux",
            home: appRoot,
            env: {},
            userCacheRoot: join(appRoot, "cache"),
          }),
        ),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (service) =>
      service.plan(literalTestLandofile(landofile, appRoot), capabilities),
    ).pipe(Effect.provide(planner)),
  );
};

const withAppRoot = async <T>(run: (appRoot: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-renumber-"));
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  try {
    return await run(appRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("AppPlanner image-renumber realization", () => {
  test.skipIf(!hostIsUsable)("plans the PHP project user with the host ids and a renumber step", async () => {
    await withAppRoot(async (appRoot) => {
      const result = await plan(
        appRoot,
        Schema.decodeUnknownSync(LandofileShape)({
          name: "renumber-app",
          runtime: 4,
          services: { web: { type: "php:8.3" } },
        }),
      );
      const web = result.services[ServiceName.make("web")];
      if (web === undefined || host === undefined) throw new Error("expected a planned web service");
      expect(web.projectUser).toEqual({
        name: "www-data",
        uid: Number(host.uid),
        gid: Number(host.gid),
      });
      expect(web.extensions["@lando/core/project-user-mapping"]).toBe("image-renumber");
      const steps = serviceFeatureBuildSteps(web.extensions);
      expect(steps[0]?.id).toBe(projectUserRenumberStepId);
      expect(steps[0]?.user).toBe("root");
      const ownership = steps.findIndex((step) => step.id === DATA_TREE_OWNERSHIP_STEP_ID);
      expect(ownership).toBeGreaterThan(0);
    });
  });

  test.skipIf(!hostIsUsable)("leaves the image account alone when the service opts out", async () => {
    await withAppRoot(async (appRoot) => {
      const result = await plan(
        appRoot,
        Schema.decodeUnknownSync(LandofileShape)({
          name: "renumber-app",
          runtime: 4,
          services: { web: { type: "php:8.3", projectUser: false } },
        }),
      );
      const web = result.services[ServiceName.make("web")];
      if (web === undefined) throw new Error("expected a planned web service");
      expect(web.projectUser).toBeUndefined();
      expect(web.projectUserExplanation?.state).toBe("opted-out");
      expect(serviceFeatureBuildSteps(web.extensions).map((step) => step.id)).not.toContain(
        projectUserRenumberStepId,
      );
    });
  });
});
