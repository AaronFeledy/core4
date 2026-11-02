import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@lando/sdk/plugins";
import { type LandofileShape, PluginManifest, ServiceName } from "@lando/sdk/schema";
import {
  type AppFeatureDefinition,
  CacheService,
  PluginRegistry,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as AppCacheService from "../../src/cache/service.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { snapshotAppFeatureEnv } from "../../src/services/app-feature.ts";
import { planApp } from "../plan-app.ts";

const featureFor = (fromConfig: string): AppFeatureDefinition => ({
  id: "test.selector-env",
  priority: 100,
  selectors: { fromConfig },
  apply: (context) =>
    Effect.sync(() => context.forEachSelected((service) => service.addEnv("SELECTED", "true"))),
});

for (const scenario of [
  { name: "misses when a referenced variable changes", change: "referenced", writes: 2, selected: "worker" },
  { name: "hits when referenced variables are unchanged", change: "none", writes: 1, selected: "web" },
  { name: "hits when only an unrelated variable changes", change: "unrelated", writes: 1, selected: "web" },
  {
    name: "uses the keyed snapshot during composition",
    change: "during-composition",
    writes: 2,
    selected: "worker",
  },
] as const) {
  test(`planApp selector env cache ${scenario.name}`, async () => {
    // Given: a real disk cache and a plugin selecting one of two service drafts.
    const root = await mkdtemp(join(tmpdir(), "lando-selector-env-"));
    const previous = {
      LANDO_USER_CACHE_ROOT: process.env.LANDO_USER_CACHE_ROOT,
      LANDO_QA_SEL: process.env.LANDO_QA_SEL,
      LANDO_QA_UNRELATED: process.env.LANDO_QA_UNRELATED,
    };
    process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
    process.env.LANDO_QA_SEL = "web";
    try {
      const serviceType: ServiceType = {
        id: "selector-service",
        name: "selector-service",
        base: "l337",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "l337",
            normalizedConfig: input.service,
            features: [{ id: "test.env-mutation" }],
          }),
      };
      const feature = featureFor("{{ [env.LANDO_QA_SEL] }}");
      const plugin = definePlugin({
        name: "@example/selector-env",
        manifest: Schema.decodeUnknownSync(PluginManifest)({
          name: "@example/selector-env",
          version: "1.0.0",
          api: 4,
          entry: "index.js",
          contributes: {
            serviceTypes: [serviceType.id],
            appFeatures: [feature.id],
            serviceFeatures: ["test.env-mutation"],
          },
        }),
        serviceTypes: new Map([[serviceType.id, serviceType]]),
        appFeatures: new Map([[feature.id, feature]]),
        serviceFeatures: new Map([
          [
            "test.env-mutation",
            {
              id: "test.env-mutation",
              priority: 100,
              apply: () =>
                Effect.sync(() => {
                  if (scenario.change === "during-composition") process.env.LANDO_QA_SEL = "worker";
                }),
            },
          ],
        ]),
      });
      const landofile: LandofileShape = {
        name: "selector-env",
        services: Object.fromEntries(
          ["web", "worker"].map((name) => [
            ServiceName.make(name),
            { type: serviceType.id, image: "alpine:3.22", home: false, appMount: false },
          ]),
        ),
      };
      const cache = await Effect.runPromise(Effect.provide(CacheService, AppCacheService.layer));
      let writes = 0;
      const runPlan = () =>
        Effect.runPromise(
          Effect.flatMap(PluginRegistry, (registry) =>
            compileTestLandofile(landofile, root).pipe(
              Effect.flatMap((compiled) =>
                planApp(
                  {
                    landofile: compiled,
                    providerCapabilities: TestRuntimeProvider.capabilities,
                    appRoot: root,
                  },
                  Layer.mergeAll(
                    Layer.succeed(PluginRegistry, registry),
                    Layer.succeed(CacheService, {
                      ...cache,
                      writeAtomic: (path, bytes) =>
                        cache.writeAtomic(path, bytes).pipe(Effect.tap(() => Effect.sync(() => writes++))),
                    }),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.provide(PluginRegistryLayer.layerWith({ app: false, user: false }, [plugin]))),
        );
      const first = await runPlan();
      expect(first.services[ServiceName.make("web")]?.environment.SELECTED).toBe("true");
      expect(first.services[ServiceName.make("worker")]?.environment.SELECTED).toBeUndefined();
      expect(writes).toBe(1);

      // When: only the requested environment input changes between two plans.
      if (scenario.change === "referenced") process.env.LANDO_QA_SEL = "worker";
      if (scenario.change === "unrelated") process.env.LANDO_QA_UNRELATED = "changed";
      const second = await runPlan();

      // Then: relevant changes recompose; identical selector inputs reuse the cache.
      expect(writes).toBe(scenario.writes);
      for (const name of ["web", "worker"]) {
        const selected = second.services[ServiceName.make(name)]?.environment.SELECTED;
        if (name === scenario.selected) expect(selected).toBe("true");
        else expect(selected).toBeUndefined();
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const expression of ["{{ env[env.LOOKUP] }}", "{{ keys(env) }}", '{{ get(env, "TARGET") }}']) {
  test(`selector cache projects the whole env for ${expression}`, () => {
    // Given
    const env = { TARGET: "web", LOOKUP: "TARGET", UNRELATED: "also-needed" };
    // When
    const snapshot = snapshotAppFeatureEnv([{ id: "test", definition: featureFor(expression) }], env);
    // Then
    expect(snapshot.bindings).toEqual(env);
    expect(Object.keys(snapshot.bindings)).toEqual(["LOOKUP", "TARGET", "UNRELATED"]);
  });
}

test("selector cache unions static env reads with absent values and shell parameters", () => {
  // Given
  const features = [
    '{{ env.Z ? [env["TARGET"]] : [env.MISSING] }}',
    "${SHELL_TARGET}",
    "{{ (env).PAREN }}",
  ].map((expression) => ({ id: expression, definition: featureFor(expression) }));
  // When
  const snapshot = snapshotAppFeatureEnv(features, { TARGET: "web", Z: "", UNRELATED: "ignored" });
  // Then
  expect(snapshot.bindings).toEqual({ MISSING: null, PAREN: null, SHELL_TARGET: null, TARGET: "web", Z: "" });
  expect(Object.keys(snapshot.bindings)).toEqual(["MISSING", "PAREN", "SHELL_TARGET", "TARGET", "Z"]);
});
import { compileTestLandofile } from "../compiled-landofile.ts";
