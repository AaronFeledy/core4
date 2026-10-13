import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { GlobalConfig, ProviderId, ServiceName } from "@lando/sdk/schema";
import { ConfigService, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { plugin as serviceLando } from "@lando/service-lando";
import { Effect, Layer, Schema } from "effect";

import * as GlobalAppLayer from "../../src/global-app/service.ts";
import { loadGlobalPlan } from "../../src/operations/global-plan.ts";
import { publishGlobalRoutes } from "../../src/operations/global-routes.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as PlannerLayer from "../../src/services/planner.ts";

test("global Mailpit preserves its expression in dist and replans it after a domain change", async () => {
  // Given: the actual Mailpit contribution materialized by the global-app service.
  const root = await mkdtemp(join(import.meta.dir, ".dashboard-domain-"));
  let config = Schema.decodeUnknownSync(GlobalConfig)({ userDataRoot: root });
  const configLayer = Layer.succeed(ConfigService, {
    load: Effect.sync(() => config),
    get: (key) => Effect.sync(() => config[key]),
  });
  const infrastructure = Layer.mergeAll(configLayer, BunFileSystem.layer);
  const registry = PluginRegistryLayer.layerWith({ user: false, app: false }, [serviceLando]);
  const layer = Layer.mergeAll(
    GlobalAppLayer.layer.pipe(Layer.provide(infrastructure)),
    PlannerLayer.layer.pipe(Layer.provide(Layer.mergeAll(registry, infrastructure))),
    BunFileSystem.layer,
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
  );
  const mail = ServiceName.make("mailpit");
  const contribution = serviceLando.globalServices?.get("mailpit");
  if (contribution === undefined) throw new Error("Mailpit global contribution missing");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const globalApp = yield* GlobalAppService;
        const mailpit = yield* contribution;
        yield* globalApp.regenerateDist({ services: { mailpit } });
      }).pipe(Effect.provide(layer)),
    );
    const initial = await Effect.runPromise(loadGlobalPlan().pipe(Effect.provide(layer)));
    if (!initial.materialized) throw new Error("Global app was not materialized");
    expect(initial.landofile.services?.[mail]?.routes).toEqual([
      { hostname: "mailpit.{{ proxy.defaultDomain }}", endpoint: 8025 },
    ]);
    expect(initial.plan.routes.map((route) => route.hostname)).toEqual(["mailpit.lndo.site"]);
    config = Schema.decodeUnknownSync(GlobalConfig)({
      userDataRoot: root,
      proxy: { defaultDomain: "custom.test" },
    });

    // When: the unchanged dist file is planned and published with the new global domain.
    const changed = await Effect.runPromise(loadGlobalPlan().pipe(Effect.provide(layer)));
    if (!changed.materialized) throw new Error("Global app was not materialized");
    const router = makeTestRouterService();
    const urls = await Effect.runPromise(
      publishGlobalRoutes(router, TestRuntimeProvider, changed.plan, {
        started: new Set([mail]),
        failed: new Set(),
      }),
    );

    // Then: planning and publication use the new domain without regenerating global YAML.
    expect(changed.plan.routes.map((route) => route.hostname)).toEqual(["mailpit.custom.test"]);
    expect(urls.get(mail)).toEqual(["https://mailpit.custom.test:38443"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
