import { expect, test } from "bun:test";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  declarePreparedServiceEndpoints,
  prepareServiceComposition,
} from "../../src/services/feature-preparation.ts";
import {
  type ComposeServiceInput,
  applyPreparedService,
  composeService,
} from "../../src/services/feature.ts";

const inputFor = (definition: ServiceFeatureDefinition): ComposeServiceInput => ({
  base: {
    name: ServiceName.make("web"),
    type: "custom",
    provider: ProviderId.make("test"),
    primary: true,
    environment: { BASE: "preserved" },
    defaultFeatures: [],
  },
  baseKind: "l337",
  appRoot: "/srv/prepared",
  normalizedConfig: { environment: { AUTHORED: "yes" } },
  features: [
    { id: definition.id, definition, config: { port: 8123 } },
    { id: definition.id, definition, config: { port: 9234 } },
  ],
});

test("direct composition reuses declaration-decoded configuration per occurrence", async () => {
  let decodes = 0;
  const declarations: unknown[] = [];
  const applications: unknown[] = [];
  const definition: ServiceFeatureDefinition = {
    id: "test.occurrence",
    priority: 100,
    schema: Schema.Struct({ port: Schema.Number }).check(
      Schema.makeFilter(() => {
        decodes++;
        return true;
      }),
    ),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        declarations.push(ctx.config);
        return [{ _tag: "internal", protocol: "http", port: Number(ctx.config.port) }];
      }),
    apply: (ctx) =>
      Effect.sync(() => {
        applications.push(ctx.config);
        ctx.addEnv("LAST", String(ctx.config.port));
      }),
  };
  const plan = await Effect.runPromise(composeService(inputFor(definition)));
  expect(plan.endpoints.map((endpoint) => ("port" in endpoint ? endpoint.port : undefined))).toEqual([
    8123, 9234,
  ]);
  expect(plan.environment).toMatchObject({ BASE: "preserved", LAST: "9234" });
  expect(decodes).toBe(2);
  expect(declarations).toHaveLength(2);
  expect(applications[0]).toBe(declarations[0]);
  expect(applications[1]).toBe(declarations[1]);
});

test("materialized empty config is decoded without replacing original declaration config", async () => {
  let decodes = 0;
  const seen: unknown[] = [];
  const definition: ServiceFeatureDefinition = {
    id: "test.materialized",
    priority: 100,
    schema: Schema.Struct({ port: Schema.optional(Schema.Number) }).check(
      Schema.makeFilter(() => {
        decodes++;
        return true;
      }),
    ),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        seen.push(ctx.config);
        return [];
      }),
    apply: (ctx) =>
      Effect.sync(() => {
        seen.push(ctx.config);
        ctx.addEnv("PORT", String(ctx.config.port));
      }),
  };
  const initial = prepareServiceComposition({
    ...inputFor(definition),
    features: [{ id: definition.id, definition, config: { port: 8123 } }],
  });
  const declared = await Effect.runPromise(declarePreparedServiceEndpoints(initial));
  const applied = await Effect.runPromise(
    applyPreparedService({
      prepared: declared.prepared,
      endpointContributions: declared.contributions,
      applicationConfigs: new Map([[0, { _tag: "Materialized", config: {} }]]),
    }),
  );
  expect(applied.plan.environment.PORT).toBe("undefined");
  expect(seen).toEqual([{ port: 8123 }, {}]);
  expect(declared.prepared.features[0]?.originalRawConfig).toEqual({ port: 8123 });
  expect(declared.prepared.features[0]?.originalDecodedConfig).toEqual({ port: 8123 });
  expect(decodes).toBe(2);
});

test("application-only schemas are deferred until apply and decode the materialized value", async () => {
  let decodes = 0;
  const definition: ServiceFeatureDefinition = {
    id: "test.application-only",
    priority: 100,
    schema: Schema.Struct({ ready: Schema.String }).check(
      Schema.makeFilter(() => {
        decodes++;
        return true;
      }),
    ),
    apply: (ctx) => Effect.sync(() => ctx.addEnv("READY", String(ctx.config.ready))),
  };
  const initial = prepareServiceComposition({
    ...inputFor(definition),
    features: [{ id: definition.id, definition, config: { unresolved: true } }],
  });
  const declared = await Effect.runPromise(declarePreparedServiceEndpoints(initial));
  expect(decodes).toBe(0);
  const applied = await Effect.runPromise(
    applyPreparedService({
      prepared: declared.prepared,
      endpointContributions: declared.contributions,
      applicationConfigs: new Map([[0, { _tag: "Materialized", config: { ready: "materialized" } }]]),
    }),
  );
  expect(applied.plan.environment.READY).toBe("materialized");
  expect(decodes).toBe(1);
});
