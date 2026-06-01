import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";

import {
  type DoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../src/cli/commands/doctor-report.ts";
import { metaDoctorSpec } from "../../src/cli/oclif/commands/meta/doctor.ts";

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
  test("aggregates the selected provider checks, every subsystem check, and the global-app check", async () => {
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
    expect(report.globalApp.checks[0]?.name).toBe("global-app");
  });

  test("renderDoctorReport surfaces provider section, every subsystem, and global-app section", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const text = renderDoctorReport(report);

    expect(text).toContain("selected-provider: pass");
    for (const name of ["proxy", "certs", "ssh", "healthcheck", "scanner", "host-proxy"]) {
      expect(text).toContain(`${name}:`);
    }
    expect(text).toContain("global-app:");
    expect(text).toContain("solution[manual]:");
    expect(text).toContain("lando setup");
    expect(text).not.toContain("[object Object]");
  });

  test("does not require app bootstrap — runs with only ConfigService + RuntimeProviderRegistry", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    expect(report.subsystems.checks.length).toBe(6);
    expect(report.globalApp.checks.length).toBe(1);
  });

  test("global-app check reports not-installed when no userDataRoot is configured", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const check = report.globalApp.checks[0];
    expect(check?.name).toBe("global-app");
    expect(check?.status).toBe("warn");
    expect(check?.context.installed).toBe("false");
    expect(check?.solutions[0]?.command).toBe("lando global:install");
  });

  test("combined ndjson renderer emits provider, subsystem, and global-app checks in one stream", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const ndjson = renderDoctorReportAsNdjson(report, { now: new Date("1970-01-01T00:00:00.000Z") });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]).toEqual({ _tag: "doctor.start", timestamp: "1970-01-01T00:00:00.000Z" });
    expect(lines.slice(1, -1).map((line) => line.name)).toEqual([
      "selected-provider",
      "proxy",
      "certs",
      "ssh",
      "healthcheck",
      "scanner",
      "host-proxy",
      "global-app",
    ]);
    expect(lines.at(-1)).toEqual({
      _tag: "doctor.complete",
      timestamp: "1970-01-01T00:00:00.000Z",
      checks: 8,
      failed: 0,
      warned: 7,
    });
  });

  test("meta:doctor render path honors json renderer mode for the combined report", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const rendered = metaDoctorSpec.render?.(report, { rendererMode: "json" });

    expect(rendered).toStartWith('{"_tag":"doctor.start"');
    expect(rendered).toContain('"name":"selected-provider"');
    expect(rendered).toContain('"name":"host-proxy"');
    expect(rendered).toContain('"name":"global-app"');
    expect(rendered).toContain('"checks":8');
  });

  test("doctorReport runs the shared app:config:lint pass and renders it under --app", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-app-")));
    await writeFile(join(dir, ".lando.yml"), "name: doctor-app\nbogusKey: nope\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      const report = await Effect.runPromise(
        doctorReport({ app: true }).pipe(Effect.provide(buildLayers(provider))),
      );

      expect(report.appConfig).toBeDefined();
      expect(report.appConfig?.valid).toBe(false);
      expect(report.appConfig?.violations.some((v) => v.path.includes("bogusKey"))).toBe(true);

      const text = renderDoctorReport(report);
      expect(text).toContain("app-config-lint: fail");

      const ndjson = renderDoctorReportAsNdjson(report, { now: new Date("1970-01-01T00:00:00.000Z") });
      const lines = ndjson
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.slice(1, -1).map((line) => line.name)).toContain("app-config-lint");
      expect(lines.at(-1)).toMatchObject({ checks: 9, failed: 1 });
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
