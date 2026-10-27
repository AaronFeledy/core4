import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifest, PluginName } from "@lando/sdk/schema";
import {
  AppPlanner,
  PluginRegistry,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as Cache from "../../src/cache/service.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import * as Planner from "../../src/services/planner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

test.each([
  ["literal", "echo literal"],
  ["static", "echo {{ env.CACHE_REFERENCED }}"],
  ["dynamic", "echo {{ env[env.CACHE_SELECTOR] }}"],
  ["runtime", "echo {{ event.enabled ? env.CACHE_REFERENCED : env.CACHE_MISSING }}"],
] as const)(
  "%s planner cache ignores unrelated secret-store env and tracks referenced values",
  async (kind, command) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-env-cache-")));
    const original = {
      cwd: process.cwd(),
      cache: process.env.LANDO_USER_CACHE_ROOT,
      secret: process.env.LANDO_SECRET_CACHE_CANARY,
      referenced: process.env.CACHE_REFERENCED,
      selector: process.env.CACHE_SELECTOR,
    };
    let featureCalls = 0;
    const feature: ServiceFeatureDefinition = {
      id: "cache-input-counter",
      priority: 1000,
      apply: () =>
        Effect.sync(() => {
          featureCalls += 1;
        }),
    };
    const serviceType: ServiceType = {
      id: "cache-input-test",
      name: "cache-input-test",
      base: "l337",
      schema: Schema.Unknown,
      resolve: (input) =>
        Effect.succeed({ base: "l337", normalizedConfig: input.service, features: [{ id: feature.id }] }),
    };
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: PluginName.make("@lando/cache-input-test"),
      version: "1.0.0",
      api: 4,
      contributes: { serviceTypes: [serviceType.id] },
    });
    const registry = Layer.effect(
      PluginRegistry,
      Effect.map(PluginRegistry, (base) =>
        PluginRegistry.of({
          ...base,
          list: Effect.succeed([manifest]),
          loadServiceType: () => Effect.succeed(serviceType),
          loadServiceFeature: (id) =>
            id === feature.id ? Effect.succeed(feature) : base.loadServiceFeature(id),
        }),
      ),
    ).pipe(Layer.provide(Registry.layerWith({ bundled: false }, [])));
    const layer = Planner.layer.pipe(Layer.provide(Layer.mergeAll(Cache.layer, FileSystem.layer, registry)));
    const document = {
      name: "env-cache",
      services: { web: { type: serviceType.id, home: false } },
      events: { "pre-start": [command] },
    };
    try {
      process.chdir(root);
      process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
      process.env.LANDO_SECRET_CACHE_CANARY = "unrelated-first";
      process.env.CACHE_REFERENCED = "first";
      process.env.CACHE_SELECTOR = "CACHE_REFERENCED";
      await writeFile(join(root, ".lando.yml"), "name: env-cache\n");
      const run = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const planner = yield* AppPlanner;
            return yield* planner.plan(
              yield* compileTestLandofile(document, root),
              TestRuntimeProvider.capabilities,
            );
          }).pipe(Effect.provide(layer)),
        );
      const fresh = await run();
      process.env.LANDO_SECRET_CACHE_CANARY = "unrelated-second";
      const hit = await run();
      expect(featureCalls).toBe(1);
      expect(hit.events).toEqual(fresh.events);
      process.env.CACHE_REFERENCED = "second";
      await run();
      expect(featureCalls).toBe(kind === "literal" ? 1 : 2);
    } finally {
      process.chdir(original.cwd);
      for (const [name, value] of Object.entries({
        LANDO_USER_CACHE_ROOT: original.cache,
        LANDO_SECRET_CACHE_CANARY: original.secret,
        CACHE_REFERENCED: original.referenced,
        CACHE_SELECTOR: original.selector,
      })) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
