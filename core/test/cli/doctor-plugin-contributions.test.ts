import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
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
  Layer.mergeAll(
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(ConfigService, buildConfigService()),
    Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} })),
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

  test("redacts every plugin-authored string before including the report", async () => {
    // Given
    const secret = "plugin-doctor-secret-9f3a7c2e";
    const module = doctorModule({
      id: "test-redaction",
      run: () =>
        Effect.succeed([
          {
            name: "test-redaction",
            status: "warn",
            severity: "warn",
            runtimeStatus: `Authorization: Bearer ${secret}`,
            runtime: { running: false, version: secret },
            context: { [secret]: secret, password: "hunter2" },
            solutions: [
              {
                kind: "manual",
                description: `Replace ${secret}`,
                command: `example --token=${secret}`,
              },
            ],
          },
        ]),
    });

    // When
    const result = await Effect.runPromise(
      doctor({ env: { PLUGIN_API_TOKEN: secret } }, [module]).pipe(Effect.provide(doctorLayer())),
    );

    // Then
    const report = result.checks.find((check) => check.name === "test-redaction");
    expect(report).toBeDefined();
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("hunter2");
    expect(JSON.stringify(report)).toContain("[redacted]");
  });

  test("drops an oversized plugin context with an attributed self check", async () => {
    // Given
    const module = doctorModule({
      id: "test-oversized-context",
      run: () =>
        Effect.succeed([
          {
            name: "test-oversized-context",
            status: "warn",
            severity: "warn",
            context: { evidence: "x".repeat(2_001) },
            solutions: [],
          },
        ]),
    });

    // When
    const result = await Effect.runPromise(doctor({}, [module]).pipe(Effect.provide(doctorLayer())));

    // Then
    expect(result.checks.some((check) => check.name === "test-oversized-context")).toBe(false);
    expect(result.checks.some((check) => check.name === "selected-provider")).toBe(true);
    expect(result.selfChecks).toContainEqual(
      expect.objectContaining({
        section: "plugin-check:test-oversized-context",
        reason: "failure",
        context: expect.objectContaining({
          checkId: "test-oversized-context",
          failure: "PluginDoctorReportInvalidError",
        }),
      }),
    );
  });

  test("drops more than 32 reports from one plugin check", async () => {
    // Given
    const module = doctorModule({
      id: "test-excess-reports",
      run: () =>
        Effect.succeed(
          Array.from({ length: 33 }, (_, index) => ({
            name: `test-excess-report-${index}`,
            status: "warn" as const,
            severity: "warn" as const,
            context: {},
            solutions: [],
          })),
        ),
    });

    // When
    const result = await Effect.runPromise(doctor({}, [module]).pipe(Effect.provide(doctorLayer())));

    // Then
    expect(result.checks.some((check) => check.name.startsWith("test-excess-report-"))).toBe(false);
    expect(result.selfChecks).toContainEqual(
      expect.objectContaining({
        section: "plugin-check:test-excess-reports",
        reason: "failure",
        context: expect.objectContaining({
          checkId: "test-excess-reports",
          failure: "PluginDoctorReportInvalidError",
        }),
      }),
    );
  });

  test("fails closed on an invalid plugin report shape without killing doctor", async () => {
    // Given: JSON mirrors an untyped JavaScript plugin crossing the runtime boundary.
    const module = doctorModule({
      id: "test-invalid-shape",
      run: () =>
        Effect.sync(() =>
          JSON.parse(
            '[{"name":"test-invalid-shape","status":"unknown","severity":"warn","context":{},"solutions":[]}]',
          ),
        ),
    });

    // When
    const result = await Effect.runPromise(doctor({}, [module]).pipe(Effect.provide(doctorLayer())));

    // Then
    expect(result.checks.some((check) => check.name === "test-invalid-shape")).toBe(false);
    expect(result.checks.some((check) => check.name === "selected-provider")).toBe(true);
    expect(result.selfChecks).toContainEqual(
      expect.objectContaining({
        section: "plugin-check:test-invalid-shape",
        reason: "failure",
        context: expect.objectContaining({
          checkId: "test-invalid-shape",
          failure: "PluginDoctorReportInvalidError",
        }),
      }),
    );
  });
});
