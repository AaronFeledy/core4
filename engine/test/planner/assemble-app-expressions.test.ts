import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
} from "@lando/landofile/tooling-include-provenance";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { planApp } from "../../src/planner/assemble.ts";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

const serviceType: ServiceType = {
  id: "expression-database",
  name: "expression-database",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: {
        ...input.service,
        environment: { DATABASE: String(input.service.database) },
      },
      features: [],
    }),
};

const plan = Effect.fnUntraced(function* (landofile: LandofileShape) {
  const registry = yield* PluginRegistry;
  return yield* planApp(
    { ...registry, loadServiceType: () => Effect.succeed(serviceType) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    landofile,
    TestRuntimeProvider.capabilities,
  );
}, Effect.provide(PluginRegistryLayer.layer));

test("materializes app and proxy expressions before service resolution and tooling compilation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-app-expression-"));
  try {
    const landofile = rememberInternalToolingTasks(
      rememberLandofileAppRoot(
        {
          name: "DCMS Demo",
          services: {
            [ServiceName.make("database")]: {
              type: serviceType.id,
              home: false as const,
              database: "{{ app.name }}",
            },
          },
          tooling: {
            install: { service: "database", cmd: "install {{ app.name }}.{{ proxy.defaultDomain }}" },
          },
          "x-expression": "{{ app.slug }}.{{ proxy.defaultDomain }}",
        },
        root,
      ),
      ["install"],
    );
    const app = await Effect.runPromise(plan(landofile));
    expect(app.slug).toBe("dcms-demo");
    expect(app.services[ServiceName.make("database")]?.environment.DATABASE).toBe("dcms-demo");
    const tooling = effectiveToolingForPlan(app);
    expect(tooling?.install?.cmd).toBe("install dcms-demo.lndo.site");
    if (tooling === undefined) throw new Error("Expected attached tooling");
    expect(getInternalToolingTasks(tooling)).toEqual(["install"]);
    expect(app.extensions.compose).toMatchObject({ "x-expression": "dcms-demo.lndo.site" });
    expect(landofile.services[ServiceName.make("database")]?.database).toBe("{{ app.name }}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails the plan with a ConfigExpressionError at the deferred value path", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-app-expression-error-"));
  try {
    const landofile = rememberLandofileAppRoot(
      {
        name: "DCMS Demo",
        services: {
          [ServiceName.make("database")]: {
            type: serviceType.id,
            home: false as const,
            database: "{{ app.nope }}",
          },
        },
      },
      root,
    );
    const result = await Effect.runPromise(plan(landofile).pipe(Effect.result));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected expression failure");
    expect(result.failure).toBeInstanceOf(ConfigExpressionError);
    expect(result.failure).toMatchObject({
      _tag: "ConfigExpressionError",
      expression: "{{ app.nope }}",
      path: "services.database.database",
      filePath: `${root}/.lando.yml`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
