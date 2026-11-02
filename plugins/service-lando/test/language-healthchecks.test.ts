import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, ConfigService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { serviceFeatures } from "../src/features/index.ts";
import { dotnetServiceType } from "../src/services/dotnet.ts";
import { go122ServiceType } from "../src/services/go.ts";
import { nodeLtsServiceType } from "../src/services/node.ts";
import { python312ServiceType } from "../src/services/python.ts";
import { ruby33ServiceType } from "../src/services/ruby.ts";
import { compileTestLandofile } from "./support/compiled-landofile.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const runtimes = [
  nodeLtsServiceType,
  python312ServiceType,
  ruby33ServiceType,
  go122ServiceType,
  dotnetServiceType,
];
test.each(runtimes)(
  "$id does not infer a server healthcheck from an authored worker command",
  async (serviceType) => {
    const plan = await composeServicePlan({
      serviceType,
      service: { type: serviceType.id, command: ["worker", "watch"] },
      appRoot: "/srv/language-checks",
      metadata: { resolvedAt: "2026-10-14T00:00:00Z", source: "language-healthchecks", runtime: 4 },
    });
    expect(plan.healthcheck).toBeUndefined();
    expect(plan.endpoints.length).toBeGreaterThan(0);
  },
);

test.each(runtimes)("$id preserves an explicitly authored readiness check", async (serviceType) => {
  const healthcheck = {
    kind: "command" as const,
    command: ["true"],
    intervalSeconds: 2,
    timeoutSeconds: 3,
    retries: 4,
    startPeriodSeconds: 7,
  };
  const plan = await composeServicePlan({
    serviceType,
    service: { type: serviceType.id, command: ["worker", "watch"], healthcheck },
    appRoot: "/srv/language-checks",
    metadata: { resolvedAt: "2026-10-14T00:00:00Z", source: "language-healthchecks", runtime: 4 },
  });
  expect(plan.healthcheck).toEqual(healthcheck);
});

const listeners = [
  { serviceType: nodeLtsServiceType, framework: "none", port: 3000, variables: ["PORT"] },
  { serviceType: python312ServiceType, framework: "none", port: 8000, variables: ["PORT"] },
  { serviceType: python312ServiceType, framework: "django", port: 8000, variables: ["PORT"] },
  {
    serviceType: python312ServiceType,
    framework: "flask",
    port: 5000,
    variables: ["PORT", "FLASK_RUN_PORT"],
  },
  {
    serviceType: python312ServiceType,
    framework: "fastapi",
    port: 8000,
    variables: ["PORT", "UVICORN_PORT"],
  },
  { serviceType: ruby33ServiceType, framework: "none", port: 3000, variables: ["PORT"] },
  { serviceType: ruby33ServiceType, framework: "rails", port: 3000, variables: ["PORT"] },
  { serviceType: go122ServiceType, framework: "none", port: 8080, variables: ["PORT"] },
  { serviceType: dotnetServiceType, framework: "none", port: 5000, variables: ["ASPNETCORE_HTTP_PORTS"] },
] as const;

for (const { serviceType, framework, port: defaultPort, variables } of listeners) {
  for (const port of [undefined, 9123]) {
    test(`${serviceType.id}/${framework} projects ${port ?? "preset port"} into listener variables`, async () => {
      // Given
      const service = {
        type: serviceType.id,
        framework,
        ...(port === undefined
          ? {}
          : {
              port,
              environment: Object.fromEntries(variables.map((variable) => [variable, String(port)])),
            }),
      };
      // When
      const plan = await composeServicePlan({
        serviceType,
        service,
        appRoot: "/srv/listeners",
        metadata: { resolvedAt: "2026-10-14T00:00:00Z", source: "listeners", runtime: 4 },
      });
      // Then
      for (const variable of variables) expect(plan.environment[variable]).toBe(String(port ?? defaultPort));
      expect(plan.endpoints).toContainEqual({
        _tag: "internal",
        port: port ?? defaultPort,
        protocol: "http",
        name: "web",
        primary: true,
      });
    });
  }

  for (const variable of variables) {
    for (const value of ["9123", "9000", "invalid", "9123;9000", "${PORT}"]) {
      test(`${serviceType.id}/${framework} validates authored ${variable}=${value} before application`, async () => {
        // Given: resolve with a non-default port, then call the pre-cache validation hook directly.
        const service = { type: serviceType.id, framework, port: 9123, environment: { [variable]: value } };
        const resolution = await Effect.runPromise(
          serviceType.resolve({
            name: "web",
            service,
            appRoot: "/srv/listeners",
            metadata: { resolvedAt: "2026-10-14T00:00:00Z", source: "listeners", runtime: 4 },
          }),
        );
        const feature = resolution.features[0];
        if (feature === undefined) throw new Error("Missing runtime feature");
        const validate = serviceFeatures.get(feature.id)?.validateEffective;
        if (validate === undefined) throw new Error("Missing pre-cache listener validation");
        // When
        const result = Effect.runSync(
          Effect.result(
            validate({
              serviceName: "web",
              serviceType: serviceType.id,
              base: "lando",
              primary: true,
              appRoot: "/srv/listeners",
              normalizedConfig: resolution.normalizedConfig,
              config: feature.config ?? {},
            }),
          ),
        );
        // Then
        if (value === "9123") expect(result._tag).toBe("Success");
        else
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { issues: [{ path: ["environment", variable] }] },
          });
      });
    }
  }
}

test.each(["node:lts", "python:3.12", "ruby:3.3", "go:1.22", "dotnet"])(
  "%s rejects a mismatched listener inherited through appEnv",
  async (type) => {
    // Given
    const variable = type === "dotnet" ? "ASPNETCORE_HTTP_PORTS" : "PORT";
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "inherited-listener",
      services: { web: { type, port: 9123, certs: false } },
    });
    const config = Schema.decodeUnknownSync(GlobalConfig)({ appEnv: { [variable]: "9000" } });
    const dependencies = Layer.merge(
      PluginRegistryLayer.layer,
      Layer.succeed(
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
      ),
    );
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(compileTestLandofile(landofile), TestRuntimeProvider.capabilities),
      ).pipe(Effect.result, Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(dependencies)))),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { issues: [{ path: ["services", "web", "environment", variable] }] },
    });
  },
);

test.each(["app", "service"])("rejects a mismatched Flask listener from a %s env file", async (owner) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-listener-env-"));
  try {
    const file = join(root, "listener.env");
    await Bun.write(file, "FLASK_RUN_PORT=9000\n");
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "file-listener",
      ...(owner === "app" ? { env_file: [file] } : {}),
      services: {
        web: {
          type: "python:3.12",
          framework: "flask",
          port: 9123,
          ...(owner === "service" ? { env_file: [file] } : {}),
        },
      },
    });
    const dependencies = Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer);
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(compileTestLandofile(landofile), TestRuntimeProvider.capabilities),
      ).pipe(Effect.result, Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(dependencies)))),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { issues: [{ path: ["services", "web", "environment", "FLASK_RUN_PORT"] }] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
