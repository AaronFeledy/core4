import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";

import { type DoctorReport, doctorReport, renderDoctorReport } from "../../src/cli/commands/doctor-report.ts";

const buildRegistry = (provider: typeof TestRuntimeProvider) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const buildConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const buildLayers = (
  provider: typeof TestRuntimeProvider,
): Layer.Layer<ConfigService | RuntimeProviderRegistry> =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, buildConfigService()),
  );

const run = (provider: typeof TestRuntimeProvider): Promise<DoctorReport> =>
  Effect.runPromise(doctorReport().pipe(Effect.provide(buildLayers(provider))));

describe("meta:doctor combined report", () => {
  test("aggregates the selected provider checks and every subsystem check", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);

    expect(report.provider.checks[0]?.name).toBe("selected-provider");
    expect(report.subsystems.checks.map((check) => check.name)).toEqual([
      "proxy",
      "certs",
      "ssh",
      "healthcheck",
      "scanner",
      "host-proxy",
    ]);
  });

  test("renderDoctorReport surfaces both the provider section and every subsystem", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const text = renderDoctorReport(report);

    expect(text).toContain("selected-provider: pass");
    for (const name of ["proxy", "certs", "ssh", "healthcheck", "scanner", "host-proxy"]) {
      expect(text).toContain(`${name}:`);
    }
    expect(text).toContain("solution[manual]:");
    expect(text).toContain("lando setup");
    expect(text).not.toContain("[object Object]");
  });

  test("does not require app bootstrap — runs with only ConfigService + RuntimeProviderRegistry", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    expect(report.subsystems.checks.length).toBe(6);
  });
});
