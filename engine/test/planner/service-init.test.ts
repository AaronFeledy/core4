import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { type ProviderCapabilities, ServiceName } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceFeatureDefinition } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { APP_PLAN_CACHE_HEADER_BYTES, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import * as AppCacheService from "../../src/cache/service.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { composeService } from "../../src/services/feature.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const name = ServiceName.make("web");
const capabilities = TestRuntimeProvider.capabilities;
const withoutNativeInit = { ...capabilities, serviceInit: false };
const layer = AppPlannerLayer.layer.pipe(
  Layer.provide(Layer.mergeAll(PluginRegistryLayer.layer, AppCacheService.layer)),
);
const document = (type: string, init?: boolean) => ({
  name: "service-init",
  runtime: 4,
  services: {
    web: {
      type: type === "node" ? "node:22" : type,
      image: "node:22-alpine",
      home: false,
      appMount: false,
      ...(init === undefined ? {} : { init }),
    },
  },
});
const plan = (input: unknown, caps: ProviderCapabilities = capabilities, root = process.cwd()) =>
  compileTestLandofile(input, root).pipe(
    Effect.flatMap((compiled) => Effect.flatMap(AppPlanner, (planner) => planner.plan(compiled, caps))),
    Effect.provide(layer),
  );

test.each([
  ["node", undefined, true],
  ["node", false, false],
  ["node", true, true],
  ["compose", undefined, undefined],
  ["compose", true, true],
  ["compose", false, false],
  ["lando", undefined, true],
] as const)("plans %s authored init %s as %s", async (type, init, expected) => {
  // Given / When
  const result = await Effect.runPromise(plan(document(type, init)));
  // Then
  expect(result.services[name]?.init).toBe(expected);
  expect(result.services[name]?.extensions.compose).not.toHaveProperty("init");
});

test.each([true, false])("authored init %s wins over an opposing service feature", async (init) => {
  // Given
  const feature: ServiceFeatureDefinition = {
    id: "opposing-init",
    priority: 100,
    apply: (ctx) => Effect.sync(() => ctx.setInit(!init)),
  };
  // When
  const result = await Effect.runPromise(
    composeService({
      base: { name, type: "node", provider: ProviderId.make("test"), primary: true, defaultFeatures: [] },
      baseKind: "lando",
      appRoot: "/tmp/init",
      normalizedConfig: { init },
      features: [{ id: feature.id, definition: feature }],
    }),
  );
  // Then
  expect(result.init).toBe(init);
});

test.each([true, false])("retains service-feature init %s through the full planner", async (init) => {
  // Given
  const registry = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (original) => ({
      ...original,
      loadServiceFeature: (id: string) =>
        original.loadServiceFeature(id).pipe(
          Effect.map((feature) => ({
            ...feature,
            apply: (ctx) => feature.apply(ctx).pipe(Effect.andThen(Effect.sync(() => ctx.setInit(init)))),
          })),
        ),
    })),
  ).pipe(Layer.provide(PluginRegistryLayer.layer));
  // When
  const result = await Effect.runPromise(
    compileTestLandofile(document("node")).pipe(
      Effect.flatMap((compiled) =>
        Effect.flatMap(AppPlanner, (planner) => planner.plan(compiled, capabilities)),
      ),
      Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(registry))),
    ),
  );
  // Then
  expect(result.services[name]?.init).toBe(init);
});

test.each([false, undefined])("fails closed when serviceInit is %s", async (supported) => {
  // Given
  const { serviceInit: _supported, ...rest } = capabilities;
  const caps = { ...rest, ...(supported === undefined ? {} : { serviceInit: supported }) };
  // When
  const result = await Effect.runPromiseExit(plan(document("node"), caps));
  // Then
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const error = Cause.findErrorOption(result.cause);
    expect(Option.isSome(error)).toBe(true);
    if (Option.isSome(error)) expect(error.value).toHaveProperty("capability", "serviceInit");
  }
});

test("allows explicit false without native init capability", async () => {
  // Given / When
  const result = await Effect.runPromise(plan(document("node", false), withoutNativeInit));
  // Then
  expect(result.services[name]?.init).toBe(false);
});

test("rechecks effective true on a warmed desired-plan cache", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-service-init-")));
  const cacheRoot = join(root, "cache");
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    const caps = withoutNativeInit;
    const input = document("node", false);
    const valid = await Effect.runPromise(plan(input, caps, root));
    const bytes = await readFile(appPlanCachePath(cacheRoot, "service-init", root));
    const payload = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
      deserialize(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
    );
    const service = valid.services[name];
    if (service === undefined) throw new Error("missing planned web service");
    await Effect.runPromise(
      writeCachedAppPlan({
        cacheRoot,
        appName: "service-init",
        appRoot: root,
        key: payload.key,
        plan: { ...valid, services: { [name]: { ...service, init: true } } },
      }).pipe(Effect.provide(AppCacheService.layer)),
    );
    // When
    const result = await Effect.runPromiseExit(plan(input, caps, root));
    // Then
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const error = Cause.findErrorOption(result.cause);
      if (Option.isNone(error)) throw new Error("missing tagged failure");
      expect(error.value).toHaveProperty("capability", "serviceInit");
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
