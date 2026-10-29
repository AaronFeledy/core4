import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, ServiceName } from "@lando/sdk/schema";
import {
  type AppFeatureDefinition,
  CacheService,
  PluginRegistry,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as Cache from "../../src/cache/service.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

test("cache hits prepare declarations but skip apply and application-only decoding; hidden original SSH config invalidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-prepared-cache-"));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
  const calls = {
    serviceLoads: 0,
    appLoads: 0,
    originalDecodes: 0,
    replacementDecodes: 0,
    serviceOnlyDecodes: 0,
    appDecodes: 0,
    appOnlyDecodes: 0,
    declarations: 0,
    applies: 0,
  };
  let originalPort = 8123;
  const ssh: ServiceFeatureDefinition = {
    id: "lando.ssh-agent",
    priority: 100,
    schema: Schema.Unknown.check(
      Schema.makeFilter((value) => {
        if (typeof value === "object" && value !== null && "port" in value) calls.originalDecodes++;
        else calls.replacementDecodes++;
        return true;
      }),
    ),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        calls.declarations++;
        return [{ _tag: "internal", protocol: "http", port: Number(ctx.config.port) }];
      }),
    apply: (ctx) =>
      Effect.sync(() => {
        calls.applies++;
        ctx.addEnv("SSH_MODE", String(ctx.config.mode));
      }),
  };
  const applicationOnly: ServiceFeatureDefinition = {
    id: "test.application-only",
    priority: 200,
    schema: Schema.Struct({}).check(
      Schema.makeFilter(() => {
        calls.serviceOnlyDecodes++;
        return true;
      }),
    ),
    apply: (ctx) => Effect.sync(() => ctx.addEnv("APPLICATION", "ready")),
  };
  const app: AppFeatureDefinition = {
    id: "test.app-declaration",
    priority: 100,
    selectors: { names: ["web"] },
    schema: Schema.Struct({}).check(
      Schema.makeFilter(() => {
        calls.appDecodes++;
        return true;
      }),
    ),
    declareEndpoints: () => Effect.succeed({}),
    apply: () =>
      Effect.sync(() => {
        calls.applies++;
      }),
  };
  const appOnly: AppFeatureDefinition = {
    id: "test.app-only",
    priority: 200,
    selectors: { names: ["web"] },
    schema: Schema.Struct({}).check(
      Schema.makeFilter(() => {
        calls.appOnlyDecodes++;
        return true;
      }),
    ),
    apply: (ctx) => Effect.sync(() => ctx.forEachSelected((service) => service.addEnv("APP_ONLY", "ready"))),
  };
  const type: ServiceType = {
    id: "prepared-cache",
    name: "prepared-cache",
    base: "l337",
    schema: Schema.Unknown,
    resolve: ({ service }) =>
      Effect.succeed({
        base: "l337",
        normalizedConfig: service,
        features: [{ id: ssh.id, config: { port: originalPort } }, { id: applicationOnly.id }],
      }),
  };
  const plugin = definePlugin({
    name: "@test/prepared-cache",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/prepared-cache",
      version: "1.0.0",
      api: 4,
      entry: "index.js",
      contributes: {
        serviceTypes: [type.id],
        serviceFeatures: [applicationOnly.id],
        appFeatures: [app.id, appOnly.id],
      },
    }),
    serviceTypes: new Map([[type.id, type]]),
    serviceFeatures: new Map([[applicationOnly.id, applicationOnly]]),
    appFeatures: new Map([
      [app.id, app],
      [appOnly.id, appOnly],
    ]),
  });
  const registry = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (base) =>
      PluginRegistry.of({
        ...base,
        loadServiceFeature: (id) => {
          calls.serviceLoads++;
          return id === ssh.id ? Effect.succeed(ssh) : base.loadServiceFeature(id);
        },
        loadAppFeature: (id) => {
          calls.appLoads++;
          return base.loadAppFeature(id);
        },
      }),
    ),
  ).pipe(Layer.provide(Registry.layerWith({ app: false, user: false }, [plugin])));
  try {
    const cache = await Effect.runPromise(CacheService.pipe(Effect.provide(Cache.layer)));
    const run = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* planApp(
            {
              landofile: yield* compileTestLandofile(
                {
                  name: "prepared-cache",
                  services: { web: { type: type.id, home: false, routes: ["prepared.lndo.site"] } },
                },
                root,
              ),
              providerCapabilities: TestRuntimeProvider.capabilities,
              appRoot: root,
            },
            Layer.mergeAll(
              Layer.succeed(PluginRegistry, yield* PluginRegistry),
              Layer.succeed(CacheService, cache),
            ),
          );
        }).pipe(Effect.provide(registry)),
      );
    const first = await run();
    expect(first.routes[0]?.backend.port).toBe(8123);
    expect(first.services[ServiceName.make("web")]?.environment).toMatchObject({
      APPLICATION: "ready",
      APP_ONLY: "ready",
      SSH_MODE: expect.any(String),
    });
    const initial = { ...calls };
    const second = await run();
    expect(second.routes[0]?.backend.port).toBe(8123);
    expect(calls).toEqual({
      ...initial,
      serviceLoads: initial.serviceLoads * 2,
      appLoads: initial.appLoads * 2,
      originalDecodes: 2,
      appDecodes: 2,
      declarations: 2,
    });
    expect(initial).toMatchObject({
      serviceLoads: 2,
      appLoads: 2,
      originalDecodes: 1,
      replacementDecodes: 1,
      serviceOnlyDecodes: 1,
      appDecodes: 1,
      appOnlyDecodes: 1,
      applies: 2,
    });
    originalPort = 9234;
    const third = await run();
    expect(third.routes[0]?.backend.port).toBe(9234);
    expect(calls).toMatchObject({
      originalDecodes: 3,
      replacementDecodes: 2,
      serviceOnlyDecodes: 2,
      appDecodes: 3,
      appOnlyDecodes: 2,
      declarations: 3,
      applies: 4,
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
