import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  PluginRegistry,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const APP_ROOT = process.cwd();

const planWithFeature = (feature: ServiceFeatureDefinition) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "host-alias-contract",
    runtime: 4,
    services: {
      web: {
        type: "alias-type",
        image: "busybox",
        home: false,
        certs: false,
        routes: [],
      } satisfies typeof ServiceConfig.Encoded,
    },
  });
  const serviceType: ServiceType = {
    id: "alias-type",
    name: "alias-type",
    base: "l337",
    schema: Schema.Unknown,
    resolve: (input) =>
      Effect.succeed({
        base: "l337",
        normalizedConfig: input.service,
        features: [{ id: feature.id }],
      }),
  };
  return Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    return yield* Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(literalTestLandofile(landofile, APP_ROOT), TestRuntimeProvider.capabilities),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provideService(PluginRegistry, {
        ...registry,
        loadServiceType: (id) =>
          id === serviceType.id ? Effect.succeed(serviceType) : registry.loadServiceType(id),
        loadServiceFeature: (id) =>
          id === feature.id ? Effect.succeed(feature) : registry.loadServiceFeature(id),
      }),
    );
  }).pipe(Effect.provide(PluginRegistryLayer.layer));
};

test("planning rejects a feature host alias that is not a HostAliasName", async () => {
  // Given: a service feature that contributes an invalid /etc/hosts hostname
  const feature: ServiceFeatureDefinition = {
    id: "test.bad-host-alias",
    priority: 100,
    apply: (ctx) =>
      Effect.sync(() => {
        ctx.addHostAlias({ hostname: "bad host", ip: "1.2.3.4" });
      }),
  };

  // When
  const exit = await Effect.runPromiseExit(planWithFeature(feature));

  // Then
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected planning failure");
  const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(failure).toBeInstanceOf(LandofileValidationError);
  if (!(failure instanceof LandofileValidationError)) throw new Error("expected plan validation failure");
  expect(failure.issues.map((issue) => issue.path)).toEqual([
    ["services", "web", "hostAliases", 0, "hostname"],
  ]);
});

test("planning accepts a feature host alias that is a HostAliasName", async () => {
  // Given
  const feature: ServiceFeatureDefinition = {
    id: "test.ok-host-alias",
    priority: 100,
    apply: (ctx) =>
      Effect.sync(() => {
        ctx.addHostAlias({ hostname: "my_db", ip: "1.2.3.4" });
      }),
  };

  // When
  const plan = await Effect.runPromise(planWithFeature(feature));

  // Then
  expect(plan.services[ServiceName.make("web")]?.hostAliases).toEqual(
    expect.arrayContaining([{ hostname: "my_db", ip: "1.2.3.4" }]),
  );
});
