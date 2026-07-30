import { describe, expect, test } from "bun:test";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { ConfigError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule, PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { type GlobalConfig, PluginManifest, ProviderId } from "@lando/sdk/schema";
import { DoctorReportSchema, doctorReport } from "../../src/cli/commands/doctor-report.ts";
import { doctor } from "../../src/cli/commands/doctor.ts";

/**
 * Chaos coverage for the doctor self-resilience contract: every service doctor
 * depends on is made to fail, die, or hang, and doctor must still answer with a
 * structured report instead of propagating the breakage it exists to report.
 */

const SHORT_BUDGET_ENV = { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } as const;

const buildConfigService = (
  options: { readonly failGet?: boolean } = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) =>
      options.failGet === true
        ? Effect.fail(new ConfigError({ message: "config file is corrupt", key: String(key) }))
        : Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const failingSelectRegistry = () => ({
  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () =>
    Effect.fail(
      new ProviderUnavailableError({
        providerId: TestRuntimeProvider.id,
        operation: "select",
        message: "runtime socket is unreachable",
      }),
    ),
});

const statusRegistry = (getStatus: typeof TestRuntimeProvider.getStatus) => ({
  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.succeed({ ...TestRuntimeProvider, getStatus }),
});

const doctorModule = (check: PluginDoctorCheckContribution): LandoPluginModule => ({
  name: "@lando/doctor-chaos",
  manifest: Schema.decodeSync(PluginManifest)({
    name: "@lando/doctor-chaos",
    version: "1.0.0",
    api: 4,
  }),
  doctorChecks: [check],
});

const layersFor = (
  registry: ReturnType<typeof statusRegistry> | ReturnType<typeof failingSelectRegistry>,
  configOptions: { readonly failGet?: boolean } = {},
) =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, registry as never),
    Layer.succeed(ConfigService, buildConfigService(configOptions)),
  );

const selfSections = (report: { readonly self?: { readonly checks: ReadonlyArray<{ section: string }> } }) =>
  (report.self?.checks ?? []).map((check) => check.section);

describe("doctor chaos: provider path", () => {
  test("reports a failed selected-provider check when provider selection fails", async () => {
    // Given a registry whose select always fails
    const layers = layersFor(failingSelectRegistry());

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then doctor answers instead of failing, and names the remediation
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check).toMatchObject({
      name: "selected-provider",
      status: "fail",
      severity: "error",
      runtimeStatus: "unavailable",
    });
    expect(check?.context.failure).toBe("ProviderUnavailableError");
    expect(check?.solutions.map((solution) => solution.command)).toContain("lando setup");
    expect(check?.selection?.providerId).toBe("lando");
  });

  test("degrades to a failed check when the provider status probe fails", async () => {
    // Given
    const layers = layersFor(
      statusRegistry(
        Effect.fail(
          new ProviderUnavailableError({
            providerId: TestRuntimeProvider.id,
            operation: "getStatus",
            message: "status probe exploded",
          }),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check?.status).toBe("fail");
    expect(check?.context.statusProbe).toBe("failure");
    expect(result.selfChecks?.map((entry) => entry.section)).toContain("provider-status");
  });

  test("bounds a hanging provider status probe and keeps answering", async () => {
    // Given a status probe that never settles
    const layers = layersFor(statusRegistry(Effect.never as typeof TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(doctor({ env: SHORT_BUDGET_ENV }).pipe(Effect.provide(layers)));

    // Then
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check?.status).toBe("fail");
    expect(check?.context.statusProbe).toBe("timeout");
    expect(check?.runtimeStatus).toContain("timed out");
  });

  test("records a self check when configuration cannot be read", async () => {
    // Given a ConfigService whose reads always fail
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus), { failGet: true });

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then selection still resolves from the capability default
    expect(result.selfChecks?.map((entry) => entry.section)).toContain("provider-selection-config");
    expect(result.checks.find((entry) => entry.name === "selected-provider")).toBeDefined();
  });
});

describe("doctor chaos: plugin-contributed checks", () => {
  test("attributes a dying plugin check instead of failing the run", async () => {
    // Given
    const module = doctorModule({ id: "chaos-die", run: () => Effect.die(new Error("plugin exploded")) });
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(doctor({}, [module]).pipe(Effect.provide(layers)));

    // Then the built-in checks survive and the failure is attributed
    expect(result.checks.find((entry) => entry.name === "selected-provider")).toBeDefined();
    const self = result.selfChecks?.find((entry) => entry.section === "plugin-check:chaos-die");
    expect(self).toMatchObject({ status: "fail", severity: "error", reason: "defect" });
    expect(self?.context.checkId).toBe("chaos-die");
  });

  test("bounds a hanging plugin check", async () => {
    // Given
    const module = doctorModule({ id: "chaos-hang", run: () => Effect.never });
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(
      doctor({ env: SHORT_BUDGET_ENV }, [module]).pipe(Effect.provide(layers)),
    );

    // Then
    const self = result.selfChecks?.find((entry) => entry.section === "plugin-check:chaos-hang");
    expect(self?.reason).toBe("timeout");
    expect(result.checks.find((entry) => entry.name === "selected-provider")).toBeDefined();
  });

  test("keeps healthy plugin checks when a sibling check dies", async () => {
    // Given one healthy and one dying contribution
    const healthy = doctorModule({
      id: "chaos-healthy",
      run: () =>
        Effect.succeed([
          {
            name: "chaos-healthy",
            status: "pass" as const,
            severity: "info" as const,
            context: {},
            solutions: [],
          },
        ]),
    });
    const dying: LandoPluginModule = {
      ...doctorModule({ id: "chaos-sibling-die", run: () => Effect.die(new Error("nope")) }),
      name: "@lando/doctor-chaos-2",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/doctor-chaos-2",
        version: "1.0.0",
        api: 4,
      }),
    };
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(doctor({}, [healthy, dying]).pipe(Effect.provide(layers)));

    // Then
    expect(result.checks.find((entry) => entry.name === "chaos-healthy")?.status).toBe("pass");
    expect(result.selfChecks?.map((entry) => entry.section)).toContain("plugin-check:chaos-sibling-die");
  });
});

describe("doctor chaos: whole report", () => {
  test("emits a schema-valid report when the provider section is fully broken", async () => {
    // Given provider selection failure and a corrupt config at the same time
    const layers = layersFor(failingSelectRegistry(), { failGet: true });

    // When
    const report = await Effect.runPromise(
      doctorReport({ env: SHORT_BUDGET_ENV }).pipe(Effect.provide(layers)),
    );

    // Then the report is still structured, schema-valid, and carries self checks
    expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    expect(report.provider.checks.length).toBeGreaterThan(0);
    expect(selfSections(report)).toContain("provider-selection-config");
    // Provider-section self checks are lifted to the report level, never duplicated.
    expect(report.provider).not.toHaveProperty("selfChecks");
  });

  test("redacts secrets out of a failure message before it reaches the report", async () => {
    // Given a failure message containing a value the env marks as a secret
    const secret = "super-secret-token-value";
    const registry = {
      list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: TestRuntimeProvider.id,
            operation: "select",
            message: `socket auth failed using ${secret}`,
          }),
        ),
    };
    const layers = layersFor(registry);

    // When
    const result = await Effect.runPromise(
      doctor({ env: { ...SHORT_BUDGET_ENV, LANDO_TEST_TOKEN: secret } }).pipe(Effect.provide(layers)),
    );

    // Then
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(JSON.stringify(check)).not.toContain(secret);
  });
});
