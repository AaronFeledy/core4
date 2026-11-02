import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { loadLandofileFile } from "@lando/landofile/service";
import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
} from "@lando/landofile/tooling-include-provenance";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { AbsolutePath, type LoadScopedLandofile, ServiceName } from "@lando/sdk/schema";
import { PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

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
        environment: { ...input.service.environment, DATABASE: String(input.service.database) },
      },
      features: [],
    }),
};

const plan = Effect.fnUntraced(function* (landofile: LoadScopedLandofile) {
  const registry = yield* PluginRegistry;
  return yield* planApp(
    { landofile, providerCapabilities: TestRuntimeProvider.capabilities },
    Layer.succeed(PluginRegistry, { ...registry, loadServiceType: () => Effect.succeed(serviceType) }),
  );
}, Effect.provide(PluginRegistryLayer.layer));

test.each([
  { field: 'database: "{{ env.QA }}"', environmentKey: "DATABASE" },
  { field: 'environment: "{{ { FOO: env.QA } }}"', environmentKey: "FOO" },
])("keeps load-produced expression text literal at $field", async ({ field, environmentKey }) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-load-literal-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      `name: Literal Demo\nservices:\n  database:\n    type: ${serviceType.id}\n    home: false\n    ${field}\n`,
    );
    const loaded = await Effect.runPromise(
      loadLandofileFile(file, {
        appRoot: root,
        layer: "canonical",
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
        pendingSites: [],
        compilationContext: { appRoot: AbsolutePath.make(root), env: { QA: " {{ app.name }}" } },
      }),
    );
    // When
    const app = await Effect.runPromise(plan(loaded));
    // Then
    expect(app.services[ServiceName.make("database")]?.environment[environmentKey]).toBe(" {{ app.name }}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { expression: "load('./payload.txt')", field: "database", key: "DATABASE" },
  { expression: "load('./payload.json')", field: "environment", key: "FOO" },
  { expression: "load('./payload.yml')", field: "environment", key: "FOO" },
  { expression: "import('./payload.json').value", field: "environment", key: "FOO" },
  { expression: "import('./payload.yml').value", field: "environment", key: "FOO" },
])("keeps file-helper text literal in the plan for $expression", async ({ expression, field, key }) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-file-plan-literal-"));
  try {
    await writeFile(join(root, "payload.txt"), "{{ app.name }}");
    await writeFile(join(root, "payload.json"), JSON.stringify({ FOO: "{{ app.name }}" }));
    await writeFile(join(root, "payload.yml"), 'FOO: "{{ app.name }}"\n');
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      `name: Literal Demo\nservices:\n  database:\n    type: ${serviceType.id}\n    home: false\n    ${field}: "{{ ${expression} }}"\n`,
    );
    const loaded = await Effect.runPromise(loadLandofileFile(file));
    // When
    const app = await Effect.runPromise(plan(loaded));
    // Then
    expect(app.services[ServiceName.make("database")]?.environment[key]).toBe("{{ app.name }}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-string result at a plan-time text site", async () => {
  // Given
  const landofile = {
    name: "x",
    services: {
      [ServiceName.make("database")]: {
        type: serviceType.id,
        database: "{{ eq(app.name, 'x') }}",
      },
    },
  };
  // When
  const error = await Effect.runPromise(
    compileTestLandofile(landofile).pipe(Effect.flatMap(plan), Effect.flip),
  );
  // Then
  expect(error).toMatchObject({ _tag: "ConfigExpressionError", path: ["services", "database", "database"] });
  expect(error.message).toContain("Expected string");
});

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
    const compiled = await Effect.runPromise(compileTestLandofile(landofile, root));
    rememberInternalToolingTasks(compiled.document, getInternalToolingTasks(landofile));
    const app = await Effect.runPromise(plan(compiled));
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

test("expands app.name inside Backdrop settings JSON without changing the authored value", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-backdrop-expression-"));
  try {
    const settings = (database: string) =>
      JSON.stringify({
        databases: {
          default: {
            default: {
              driver: "mysql",
              database,
              username: "lando",
              password: "lando",
              host: "database",
              port: 3306,
            },
          },
        },
      });
    const deferred = settings("{{ app.name }}");
    const landofile = rememberLandofileAppRoot(
      {
        name: "Issue1077 Before",
        services: {
          [ServiceName.make("appserver")]: {
            type: serviceType.id,
            home: false as const,
            environment: { BACKDROP_SETTINGS: deferred },
          },
        },
      },
      root,
    );
    const app = await Effect.runPromise(compileTestLandofile(landofile, root).pipe(Effect.flatMap(plan)));
    expect(app.services[ServiceName.make("appserver")]?.environment.BACKDROP_SETTINGS).toBe(
      settings("issue1077-before"),
    );
    expect(landofile.services[ServiceName.make("appserver")]?.environment?.BACKDROP_SETTINGS).toBe(deferred);
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
    const result = await Effect.runPromise(
      compileTestLandofile(landofile, root).pipe(Effect.flatMap(plan), Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected expression failure");
    expect(result.failure).toBeInstanceOf(ConfigExpressionError);
    expect(result.failure).toMatchObject({
      _tag: "ConfigExpressionError",
      expression: "{{ app.nope }}",
      path: ["services", "database", "database"],
      filePath: `${root}/.lando.yml`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
