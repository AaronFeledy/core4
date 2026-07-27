import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import type { LandoPluginModule, PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { type GlobalConfig, PluginManifest, ProviderId } from "@lando/sdk/schema";

import { doctor } from "../../src/cli/commands/doctor.ts";

const buildConfigService = (): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const buildRegistry = () => ({
  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.succeed(TestRuntimeProvider),
});

const doctorModule = (check: PluginDoctorCheckContribution): LandoPluginModule => ({
  name: "@lando/doctor-test",
  manifest: Schema.decodeSync(PluginManifest)({
    name: "@lando/doctor-test",
    version: "1.0.0",
    api: 4,
  }),
  doctorChecks: [check],
});

const doctorLayer = (registry = buildRegistry()) =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(ConfigService, buildConfigService()),
  );

describe("doctor() contributed checks", () => {
  test("appends a non-preemptive contributed report to the built-in checks", async () => {
    // Given
    const module = doctorModule({
      id: "test-non-preemptive",
      run: () =>
        Effect.succeed([
          {
            name: "test-non-preemptive",
            status: "pass",
            severity: "info",
            runtimeStatus: "ready",
            runtime: { running: true, version: "1.2.3" },
            context: { source: "fake-plugin" },
            solutions: [],
          },
        ]),
    });

    // When
    const result = await Effect.runPromise(doctor({}, [module]).pipe(Effect.provide(doctorLayer())));

    // Then
    expect(result.checks.find((check) => check.name === "test-non-preemptive")).toMatchObject({
      name: "test-non-preemptive",
      status: "pass",
      severity: "info",
      runtimeStatus: "ready",
      runtime: { running: true, version: "1.2.3" },
      context: { source: "fake-plugin" },
      solutions: [],
    });
  });

  test("returns only preemptive contributed reports before provider construction", async () => {
    // Given
    const module = doctorModule({
      id: "test-preemptive",
      run: () =>
        Effect.succeed([
          {
            name: "test-preemptive",
            status: "warn",
            severity: "warn",
            runtimeStatus: "blocked",
            runtime: { running: false },
            context: { source: "fake-plugin" },
            solutions: [{ kind: "manual", description: "Resolve the fake conflict." }],
            preempts: true,
          },
        ]),
    });
    const registryThatMustNotConstruct = {
      ...buildRegistry(),
      select: () => Effect.die("registry.select() must not run after a preemptive plugin report"),
    };

    // When
    const result = await Effect.runPromise(
      doctor({}, [module]).pipe(Effect.provide(doctorLayer(registryThatMustNotConstruct))),
    );

    // Then
    expect(result.checks.map((check) => check.name)).toEqual(["test-preemptive"]);
    expect(result.checks[0]?.selection?.providerId).toBe("lando");
  });
});
