import { expect, test } from "bun:test";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { declarePreparedAppFeature, prepareAppFeatures } from "../../src/services/app-feature-preparation.ts";
import {
  type AppFeatureServiceDraft,
  applyPreparedAppFeatures,
  composeAppFeatures,
} from "../../src/services/app-feature.ts";
import { makeDraft } from "../../src/services/draft.ts";

const draft = (name: string): AppFeatureServiceDraft => ({
  ...makeDraft({
    name: ServiceName.make(name),
    type: "custom",
    provider: ProviderId.make("test"),
    primary: false,
    defaultFeatures: [],
  }),
  serviceName: name,
  serviceType: "custom",
  base: "l337",
  normalizedConfig: {},
  featureIds: [],
});

test("prepared app selection and decoded declaration config survive changed selector inputs", async () => {
  let selections = 0;
  let decodes = 0;
  let declarations = 0;
  let declaredConfig: unknown;
  let appliedConfig: unknown;
  const services = [draft("web"), draft("worker")];
  const env = { TARGET: "web" };
  const definition: AppFeatureDefinition = {
    id: "test.prepared-app",
    priority: 100,
    selectors: { fromConfig: "{{ [env.TARGET] }}" },
    schema: Schema.Struct({}).check(
      Schema.makeFilter(() => {
        decodes++;
        return true;
      }),
    ),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        declarations++;
        declaredConfig = ctx.config;
        return Object.fromEntries(
          ctx.selected.map((view) => [
            view.serviceName,
            [{ _tag: "internal" as const, protocol: "http" as const, port: 8123 }],
          ]),
        );
      }),
    apply: (ctx) =>
      Effect.sync(() => {
        appliedConfig = ctx.config;
        ctx.forEachSelected((service) => service.addEnv("SELECTED", "true"));
      }),
  };
  const input = {
    appRoot: "/srv/app",
    services,
    features: [{ id: definition.id, definition }],
    env,
    resolveFromConfig: () =>
      Effect.sync(() => {
        selections++;
        return [env.TARGET];
      }),
  };
  const result = await Effect.runPromise(prepareAppFeatures(input));
  const activations = [];
  for (const activation of result.prepared.activations)
    activations.push((await Effect.runPromise(declarePreparedAppFeature(activation, input))).activation);
  env.TARGET = "worker";
  const applied = await Effect.runPromise(
    applyPreparedAppFeatures(input, { ...result.prepared, activations }),
  );
  expect(applied.activatedFeatures[0]?.selectedServices).toEqual(["web"]);
  expect(services[0]?.environment.SELECTED).toBe("true");
  expect(services[1]?.environment.SELECTED).toBeUndefined();
  expect(result.prepared.environment.env.TARGET).toBe("web");
  expect(appliedConfig).toBe(declaredConfig);
  expect({ selections, decodes, declarations }).toEqual({ selections: 1, decodes: 1, declarations: 1 });
});

test("direct app composer uses declarations and reuses their decoded config", async () => {
  let decodes = 0;
  const service = draft("web");
  const definition: AppFeatureDefinition = {
    id: "test.direct-app",
    priority: 100,
    schema: Schema.Struct({}).check(
      Schema.makeFilter(() => {
        decodes++;
        return true;
      }),
    ),
    declareEndpoints: () => Effect.succeed({ web: [{ _tag: "internal", protocol: "http", port: 8123 }] }),
    apply: (ctx) => Effect.sync(() => ctx.forEachSelected((selected) => selected.addEnv("APPLIED", "yes"))),
  };
  await Effect.runPromise(
    composeAppFeatures({
      appRoot: "/srv/app",
      services: [service],
      features: [{ id: definition.id, definition }],
    }),
  );
  expect(service.endpoints).toEqual([{ _tag: "internal", protocol: "http", port: 8123 }]);
  expect(service.environment.APPLIED).toBe("yes");
  expect(decodes).toBe(1);
});

test("prepared selected service disappearing fails instead of silently applying to a subset", async () => {
  const definition: AppFeatureDefinition = { id: "test.invariant", priority: 100, apply: () => Effect.void };
  const input = {
    appRoot: "/srv/app",
    services: [draft("web")],
    features: [{ id: definition.id, definition }],
  };
  const { prepared } = await Effect.runPromise(prepareAppFeatures(input));
  const result = await Effect.runPromise(
    applyPreparedAppFeatures({ ...input, services: [] }, prepared).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure).toMatchObject({
      _tag: "MutationConflict",
      service: "web",
      field: "selectedServices",
    });
});

test("inactive and nondeclaring app schemas are not decoded during preparation", async () => {
  let decodes = 0;
  const schema = Schema.Struct({ required: Schema.String }).check(
    Schema.makeFilter(() => {
      decodes++;
      return true;
    }),
  );
  const features: AppFeatureDefinition[] = [
    {
      id: "inactive",
      priority: 100,
      activatedBy: { services: { type: "missing" } },
      schema,
      declareEndpoints: () => Effect.succeed({}),
      apply: () => Effect.void,
    },
    { id: "application-only", priority: 200, schema, apply: () => Effect.void },
  ];
  const input = {
    appRoot: "/srv/app",
    services: [draft("web")],
    features: features.map((definition) => ({ id: definition.id, definition })),
  };
  const result = await Effect.runPromise(prepareAppFeatures(input));
  for (const activation of result.prepared.activations)
    await Effect.runPromise(declarePreparedAppFeature(activation, input));
  expect(result.errors).toEqual([]);
  expect(result.prepared.activations.map((activation) => activation.feature.id)).toEqual([
    "application-only",
  ]);
  expect(decodes).toBe(0);
});
