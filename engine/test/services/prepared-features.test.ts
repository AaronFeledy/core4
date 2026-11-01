import { expect, test } from "bun:test";
import { ServiceFeatureError } from "@lando/sdk/errors";
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
  const validations: unknown[] = [];
  const definition: ServiceFeatureDefinition = {
    id: "test.occurrence",
    priority: 100,
    schema: Schema.Struct({ port: Schema.Number }).check(
      Schema.makeFilter(() => {
        decodes++;
        return true;
      }),
    ),
    validateEffective: (ctx) =>
      Effect.sync(() => {
        validations.push(ctx.config);
        return { handledServiceFields: [] };
      }),
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
  expect(validations).toEqual(declarations);
  expect(validations[0]).toBe(applications[0]);
  expect(applications[0]).toBe(declarations[0]);
  expect(applications[1]).toBe(declarations[1]);
});

test("preparation aggregates independent validation failures and declares only validated occurrences", async () => {
  // Given
  const seen: number[] = [];
  const definition: ServiceFeatureDefinition = {
    id: "test.validation",
    priority: 100,
    schema: Schema.Struct({ port: Schema.Number }),
    validateEffective: (ctx) =>
      ctx.config.port === 4567
        ? Effect.succeed({ handledServiceFields: [] })
        : Effect.fail(
            new ServiceFeatureError({
              feature: "test.validation",
              message: "Invalid port",
              remediation: "Choose another port.",
              issues: [
                { path: ["port"], message: String(ctx.config.port), suggestion: "Choose another port." },
              ],
            }),
          ),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        seen.push(Number(ctx.config.port));
        return [];
      }),
    apply: () => Effect.void,
  };
  // When
  const result = await Effect.runPromise(
    declarePreparedServiceEndpoints(
      prepareServiceComposition({
        ...inputFor(definition),
        features: [
          ...inputFor(definition).features,
          { id: definition.id, definition, config: { port: 4567 } },
        ],
      }),
    ),
  );
  // Then
  expect(result.errors.flatMap((error) => error.issues ?? []).map((issue) => issue.message)).toEqual([
    "8123",
    "9234",
  ]);
  expect(seen).toEqual([4567]);
});

test.each([
  undefined,
  null,
  { handledServiceFields: "webroot" },
  { handledServiceFields: ["image"] },
  { handledServiceFields: [], issues: [] },
])("rejects malformed JavaScript feature validation results: %j", async (value) => {
  // Given a JavaScript plugin that does not honor the TypeScript return contract.
  let declarations = 0;
  const definition: ServiceFeatureDefinition = {
    id: "test.validation-result",
    priority: 100,
    validateEffective: () => Effect.succeed({ handledServiceFields: [] }),
    declareEndpoints: () =>
      Effect.sync(() => {
        declarations++;
        return [];
      }),
    apply: () => Effect.void,
  };
  Object.defineProperty(definition, "validateEffective", { value: () => Effect.succeed(value) });
  // When the shared preparation boundary receives its result.
  const result = await Effect.runPromise(
    declarePreparedServiceEndpoints(
      prepareServiceComposition({
        ...inputFor(definition),
        features: inputFor(definition).features.slice(0, 1),
      }),
    ),
  );
  // Then it reports the owning feature, rather than accepting claims or declaring endpoints.
  expect(result.errors).toMatchObject([{ _tag: "ServiceFeatureError", feature: definition.id }]);
  expect(declarations).toBe(0);
});

test("materialized empty config is decoded without replacing original declaration config", async () => {
  let decodes = 0;
  let validations = 0;
  const seen: unknown[] = [];
  const definition: ServiceFeatureDefinition = {
    id: "test.materialized",
    priority: 100,
    validateEffective: () =>
      Effect.sync(() => {
        validations++;
        return { handledServiceFields: ["webroot"] };
      }),
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
  expect(validations).toBe(1);
  expect(declared.prepared.features[0]?.validation?.handledServiceFields).toEqual(["webroot"]);
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
