import { expect, test } from "bun:test";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  PluginRegistry,
  type ServiceType,
  type ServiceTypeResolution,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { connectionClientsForPlan, effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { composeExtendedServiceType } from "../../src/services/extends.ts";
import * as Planner from "../../src/services/planner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const planClient = (options: {
  readonly direct?: boolean;
  readonly task?: "identical" | "custom";
  readonly names?: readonly string[];
  readonly emptyFactory?: boolean;
  readonly dualSource?: boolean;
}) => {
  const plugins = Layer.effect(
    PluginRegistry,
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const parent = yield* registry.loadServiceType("postgres");
      const declaration: ServiceType = {
        id: "client-authority",
        name: "client-authority",
        base: parent.base,
        schema: parent.schema,
        ...(options.direct ? {} : { extends: parent.id }),
        ...(options.direct && parent.toolingForConnection !== undefined
          ? { toolingForConnection: parent.toolingForConnection }
          : {}),
        ...(options.emptyFactory ? { toolingForConnection: () => ({}) } : {}),
        resolve: (input) =>
          parent.resolve(input).pipe(
            Effect.map(
              (resolved): ServiceTypeResolution => ({
                ...(options.direct ? resolved : { base: parent.base, normalizedConfig: {}, features: [] }),
                ...(options.task === undefined
                  ? {}
                  : {
                      tooling:
                        options.task === "identical"
                          ? resolved.tooling
                          : { psql: { cmd: "custom-client", env: { CUSTOM: "retained" } } },
                    }),
                ...(options.names === undefined ? {} : { connectionClientNames: options.names }),
                ...(options.dualSource
                  ? { nonSqlCreds: { user: "invalid", database: "invalid", password: "invalid" } }
                  : {}),
              }),
            ),
          ),
      };
      const composed = yield* composeExtendedServiceType(declaration, (id) =>
        id === parent.id ? parent : undefined,
      );
      return PluginRegistry.of({
        ...registry,
        loadServiceType: (id) =>
          id === declaration.id ? Effect.succeed(composed) : registry.loadServiceType(id),
      });
    }),
  ).pipe(Layer.provide(Registry.layerWith({ user: false, app: false })));
  return Effect.gen(function* () {
    const landofile = yield* compileTestLandofile({
      name: "client-authority",
      services: {
        database: {
          type: "client-authority",
          home: false,
          creds: { user: "user", database: "database", password: "password" },
        },
      },
    });
    const planner = yield* AppPlanner;
    return yield* planner.plan(landofile, TestRuntimeProvider.capabilities);
  }).pipe(Effect.provide(Planner.layer), Effect.provide(plugins));
};

test.each([
  { label: "inherited omission", options: {}, generated: true },
  { label: "byte-identical explicit child task", options: { task: "identical" }, generated: false },
  { label: "custom child task", options: { task: "custom" }, generated: false },
  {
    label: "explicit child reauthorization",
    options: { task: "identical", names: ["psql"] },
    generated: true,
  },
  { label: "empty child factory", options: { emptyFactory: true }, generated: false },
  { label: "direct automatic claims", options: { direct: true }, generated: true },
  { label: "direct empty claims", options: { direct: true, names: [] }, generated: false },
] satisfies readonly { label: string; options: Parameters<typeof planClient>[0]; generated: boolean }[])(
  "planner respects normalized authority for $label",
  async ({ options, generated }) => {
    const plan = await Effect.runPromise(planClient(options));
    expect(connectionClientsForPlan(plan)).toEqual(generated ? { psql: ServiceName.make("database") } : {});
    const task = effectiveToolingForPlan(plan)?.psql;
    expect(task?.description).toBe("Open the PostgreSQL client for this service.");
    expect(task?.dir).toBe(PortablePath.make("/"));
    if (options.task === "custom") {
      expect(task?.cmd).toBe("custom-client");
      expect(task?.env).toMatchObject({ CUSTOM: "retained", PGPASSWORD: "password" });
    }
  },
);

test.each([
  { names: ["missing"], direct: true },
  { dualSource: true, direct: true },
])("direct resolution rejects invalid claims or credential sources %j", async (options) => {
  const result = await Effect.runPromise(planClient(options).pipe(Effect.result));
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileValidationError" } });
});
