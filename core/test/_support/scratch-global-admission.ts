import { expect } from "bun:test";
import { join } from "node:path";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as LandoConfigService from "@lando/engine/services/config";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, type AppPlan, PluginManifest, ProviderId } from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Schema } from "effect";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import { testStateStoreLayer } from "./landofile-layer.ts";

/** Run global admission independently of the caller's scratch failure hooks. */
export const scratchGlobalAdmissionFixture = (scratchProvider: RuntimeProviderShape) => {
  let applied: AppPlan | undefined;
  const providerId = ProviderId.make(scratchProvider.id);
  const provider: RuntimeProviderShape = {
    ...scratchProvider,
    appliedPlans: Effect.sync(() => (applied === undefined ? [] : [applied])),
    apply: (plan, options) => {
      if (plan.id === "global")
        return Effect.sync(() => {
          expect(plan.root).toBe(AbsolutePath.make(join(makeLandoPaths().roots.userDataRoot, "global")));
          expect(plan.provider).toBe(providerId);
          expect(Object.keys(plan.services)).toEqual(["traefik"]);
          applied = options?.recordedPlan ?? plan;
          return { changed: true };
        });
      return Effect.sync(() => {
        const required = new Set(plan.requires?.globalServices ?? []);
        if (plan.router?.enabled !== false && plan.routes.length > 0) required.add("traefik");
        if (required.size > 0) {
          expect(applied?.root).toBe(AbsolutePath.make(join(makeLandoPaths().roots.userDataRoot, "global")));
          expect(applied?.provider).toBe(providerId);
          for (const id of required) expect(applied?.services).toHaveProperty(id);
        }
      }).pipe(Effect.andThen(scratchProvider.apply(plan, options)));
    },
    inspect: (target) =>
      target.app !== "global"
        ? scratchProvider.inspect(target)
        : Effect.gen(function* () {
            const plan = applied;
            if (
              plan === undefined ||
              plan.provider !== providerId ||
              !Object.hasOwn(plan.services, target.service) ||
              (target.plan !== undefined &&
                (target.plan.root !== plan.root || target.plan.provider !== providerId))
            ) {
              return yield* Effect.die(
                `Global fixture service ${target.service} was not applied at the requested root and provider.`,
              );
            }
            return {
              app: target.app,
              service: target.service,
              providerId,
              appRoot: plan.root,
              containerId: `global-${target.service}`,
              status: "running" as const,
              health: "healthy" as const,
              publications: { status: "present" as const, bindings: [] },
            };
          }),
    list: (options) =>
      scratchProvider.list(options).pipe(
        Effect.map((observed) => {
          const plan = applied;
          const globals =
            plan === undefined
              ? []
              : Object.values(plan.services).map((service) => ({
                  app: plan.id,
                  appRoot: plan.root,
                  providerId,
                  service: service.name,
                  containerId: `global-${service.name}`,
                  status: "running" as const,
                  health: "healthy" as const,
                  publications: { status: "present" as const, bindings: [] },
                }));
          return [...globals, ...observed].filter(
            (row) => options.app === undefined || row.app === options.app,
          );
        }),
      ),
  };
  const registryLayer = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      resolveAppliedPlan: (root) => Effect.sync(() => (applied?.root === root ? applied : undefined)),
      resolveTeardownEvidence: (root) =>
        Effect.sync(() =>
          applied?.root === root ? { kind: "applied" as const, plan: applied } : { kind: "absent" as const },
        ),
      appliedPlansFor: (root) => Effect.sync(() => (applied?.root === root ? [applied] : [])),
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/scratch-admission-test",
    version: "1.0.0",
    api: 4,
    contributes: {
      globalServices: [
        {
          id: "traefik",
          enabledByDefault: true,
          module: join(import.meta.dirname, "fixtures", "scratch-router.ts"),
        },
      ],
    },
  });
  const catalogLayer = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (registry) =>
      PluginRegistry.of({ ...registry, list: Effect.succeed([manifest]) }),
    ),
  ).pipe(Layer.provide(PluginRegistryLayer.layerWith({}, BUNDLED_PLUGIN_MODULES)));
  const admissionLayer = Layer.mergeAll(
    registryLayer,
    testStateStoreLayer,
    PrivateFileAccessService.layer,
    LandoConfigService.layer,
    BunFileSystem.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    catalogLayer,
    GlobalAppServiceLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
    ),
    Layer.succeed(RouterService, RouterService.of({ ...TestRouterService, id: "traefik" })),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (plan) => Effect.succeed(plan),
        buildApp: () => Effect.void,
      }),
    ),
  );
  return { registryLayer, admissionLayer };
};
