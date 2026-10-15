import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";

import * as GlobalAppLayer from "@lando/engine/global-app/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as ConfigLayer from "@lando/engine/services/config";
import * as FileSystemLayer from "@lando/engine/services/file-system";
import { defaultGlobalServiceModuleLoader } from "@lando/engine/services/global-services";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { parseLandofile } from "@lando/landofile/parser";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, GlobalAppService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

test("the generated global Landofile preserves the real router services' route opt-out", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-global-router-routes-"));
  try {
    await withEnvVar("LANDO_USER_DATA_ROOT", root, async () => {
      const services = Object.fromEntries(
        await Effect.runPromise(
          Effect.forEach(["traefik", "diagnostics"], (module) =>
            defaultGlobalServiceModuleLoader
              .load({
                plugin: "@lando/proxy-traefik",
                contribution: {
                  id: module === "traefik" ? "traefik" : "traefik-diagnostics",
                  module: new URL(
                    `../../../plugins/proxy-traefik/src/global-services/${module}.ts`,
                    import.meta.url,
                  ).href,
                },
              })
              .pipe(
                Effect.map(
                  (config) => [module === "traefik" ? "traefik" : "traefik-diagnostics", config] as const,
                ),
              ),
          ),
        ),
      );
      const globalAppLayer = GlobalAppLayer.layer.pipe(
        Layer.provide(Layer.mergeAll(ConfigLayer.layer, FileSystemLayer.layer)),
      );
      // When
      const generated = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (globalApp) => globalApp.regenerateDist({ services })).pipe(
          Effect.provide(globalAppLayer),
        ),
      );
      const parsed = await Effect.runPromise(
        parseLandofile({
          file: generated.path,
          content: await readFile(generated.path, "utf8"),
          cwd: join(root, "global"),
        }),
      );
      const landofile = Schema.decodeUnknownSync(LandofileShape)(parsed);
      const plan = await withCwd(
        join(root, "global"),
        () =>
          Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) =>
              planner.plan(landofile, TestRuntimeProvider.capabilities),
            ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer)))),
          ),
        [root],
      );
      // Then
      expect(plan.routes).toEqual([]);
      for (const name of ["traefik", "traefik-diagnostics"]) {
        expect(landofile.services?.[ServiceName.make(name)]?.routes).toEqual([]);
        expect(plan.services[ServiceName.make(name)]?.routes).toEqual([]);
      }
      expect(
        plan.services[ServiceName.make("traefik")]?.endpoints.filter(
          (endpoint) => endpoint._tag === "published",
        ),
      ).toHaveLength(2);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
