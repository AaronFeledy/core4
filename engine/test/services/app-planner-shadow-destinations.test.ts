import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

test.each([
  ["vendor", "vendor/"],
  ["vendor/", "./vendor"],
  ["vendor/", "vendor/"],
])("plans one canonical shadow for equivalent authored excludes %j", async (...excludes) => {
  // Given equivalent excludes, with default excludes explicitly included instead.
  const appRoot = await mkdtemp(join(tmpdir(), "lando-planner-shadow-"));
  try {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "shadowapp",
      runtime: 4,
      services: {
        web: {
          type: "node:22",
          home: false,
          appMount: {
            target: "/app",
            includes: ["node_modules", ".git", "tmp", ...(excludes.includes("vendor") ? [] : ["vendor"])],
            excludes,
          },
        },
      },
    });
    const planner = AppPlannerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLive,
          FileSystemLive,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: appRoot, env: {} })),
        ),
      ),
    );

    // When the production planner assembles the app.
    const appPlan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (service) =>
        service.plan(rememberLandofileAppRoot(landofile, appRoot), TestRuntimeProvider.capabilities),
      ).pipe(Effect.provide(planner)),
    );

    // Then canonical identity produces exactly one store and one mount.
    const store = "shadowapp-web-app-vendor-64784057";
    expect(appPlan.stores).toEqual([{ name: store, scope: "service", kind: "data" }]);
    expect(appPlan.services[ServiceName.make("web")]?.storage).toEqual([
      { store, target: PortablePath.make("/app/vendor"), readOnly: false },
    ]);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
