import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, DateTime, Effect, Layer, Schema } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import {
  type DeprecationNotice,
  type DeprecationSurfaceKind,
  type GlobalConfig,
  ProviderId,
  StreamFrame,
} from "@lando/sdk/schema";
import { DeprecationService } from "@lando/sdk/services";

import {
  type DoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsJson,
  renderDoctorReportAsNdjson,
  renderDoctorReportAsYaml,
} from "../../src/cli/commands/doctor-report.ts";
import { metaDoctorSpec } from "../../src/cli/oclif/commands/meta/doctor.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { DeprecationServiceLive } from "../../src/deprecation/service.ts";

const decodeFrames = (ndjson: string) =>
  ndjson
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));

const eventPayloads = (ndjson: string): ReadonlyArray<Record<string, unknown>> =>
  decodeFrames(ndjson).flatMap((frame) =>
    frame._tag === "event" ? [frame.payload as Record<string, unknown>] : [],
  );

const resultEnvelope = (ndjson: string) => {
  const frame = decodeFrames(ndjson).at(-1);
  if (frame?._tag !== "result") throw new Error("expected terminal result frame");
  return frame.envelope;
};

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
): Layer.Layer<ConfigService | RuntimeProviderRegistry | DeprecationService> =>
  Layer.mergeAll(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, buildConfigService()),
    DeprecationServiceLive,
  );

const run = (provider: typeof TestRuntimeProvider): Promise<DoctorReport> =>
  Effect.runPromise(doctorReport().pipe(Effect.provide(buildLayers(provider))));

const deprecationNotice = (overrides: Partial<DeprecationNotice> = {}): DeprecationNotice => ({
  since: "4.1.0",
  severity: "warn",
  replacement: "new-surface",
  removeIn: "5.0.0",
  note: "Old surface is deprecated.",
  docsUrl: "https://docs.lando.dev/deprecations/old-surface",
  ...overrides,
});

const useDeprecation = (kind: DeprecationSurfaceKind, id: string, notice = deprecationNotice()) =>
  Effect.gen(function* () {
    const deprecations = yield* DeprecationService;
    yield* deprecations.register("core", kind, id, notice);
    yield* deprecations.use({
      kind,
      id,
      notice,
      app: "doctor-app",
      plugin: kind === "plugin" || kind === "manifest-contribution" ? "legacy-plugin" : undefined,
      timestamp: DateTime.unsafeMake("2026-06-13T00:00:00.000Z"),
    });
  });

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
    const checks = eventPayloads(ndjson);
    expect(checks.map((line) => line.name)).toEqual([
      "selected-provider",
      "runtime-service",
      "proxy",
      "certs",
      "ssh",
      "healthcheck",
      "scanner",
      "host-proxy",
      "global-app",
    ]);
    expect(resultEnvelope(ndjson)).toMatchObject({
      command: "meta:doctor",
      ok: true,
      result: {
        timestamp: "1970-01-01T00:00:00.000Z",
        checks: 9,
        failed: 0,
        warned: 7,
      },
    });
  });

  test("meta:doctor render path honors json renderer mode for the combined report", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const rendered = metaDoctorSpec.render?.(report, undefined, {
      mode: "json",
      format: "ndjson",
      columns: undefined,
      isTTY: false,
    });

    expect(rendered).toStartWith('{"_tag":"event"');
    expect(rendered).toContain('"event":"doctor.check"');
    expect(rendered).toContain('"name":"selected-provider"');
    expect(rendered).toContain('"name":"host-proxy"');
    expect(rendered).toContain('"name":"global-app"');
    expect(rendered).toContain('"result":{"timestamp"');
    expect(rendered).toContain('"checks":9');
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
      expect(eventPayloads(ndjson).map((line) => line.name)).toContain("app-config-lint");
      expect(resultEnvelope(ndjson).result).toMatchObject({ checks: 10, failed: 1 });
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor --deprecations renders populated deprecation entries from summary and lookup", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* useDeprecation("recipe", "legacy-app-recipe");
        yield* useDeprecation("plugin", "legacy-plugin");
        yield* useDeprecation("manifest-contribution", "globalServices.legacy-proxy");
        yield* useDeprecation("landofile-key", "services.web.legacy");
        yield* useDeprecation("config-key", "legacy.config");
        yield* useDeprecation("env-override", "LANDO_LEGACY");
        yield* useDeprecation("command", "app:legacy");
        yield* useDeprecation("event", "legacy-event");
        yield* useDeprecation("command", "app:legacy");
        return yield* doctorReport({ deprecations: true });
      }).pipe(Effect.provide(buildLayers(provider))),
    );

    expect(report.deprecations?.entries.map((entry) => `${entry.kind}:${entry.id}`)).toContain(
      "command:app:legacy",
    );
    expect(report.deprecations?.entries).toHaveLength(8);
    const command = report.deprecations?.entries.find((entry) => entry.kind === "command");
    expect(command).toMatchObject({
      id: "app:legacy",
      severity: "warn",
      since: "4.1.0",
      removeIn: "5.0.0",
      replacement: "new-surface",
      note: "Old surface is deprecated.",
      docsUrl: "https://docs.lando.dev/deprecations/old-surface",
      source: "app:doctor-app",
      count: 2,
    });

    const text = renderDoctorReport(report);
    expect(text).toContain("deprecations:");
    expect(text).toContain(
      "kind | id | severity | since | removeIn | replacement | note | docsUrl | source | count",
    );
    expect(text).toContain("command | app:legacy | warn | 4.1.0 | 5.0.0 | new-surface");
    expect(text).toContain("manifest-contribution | globalServices.legacy-proxy");
  });

  test("doctor --deprecations labels plugin-scoped entries by plugin when app context is also present", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* useDeprecation("manifest-contribution", "legacy-plugin:globalServices.legacy-proxy");
        return yield* doctorReport({ deprecations: true });
      }).pipe(Effect.provide(buildLayers(provider))),
    );

    expect(report.deprecations?.entries[0]).toMatchObject({
      kind: "manifest-contribution",
      id: "legacy-plugin:globalServices.legacy-proxy",
      source: "plugin:legacy-plugin",
    });
    expect(renderDoctorReport(report)).toContain(
      "manifest-contribution | legacy-plugin:globalServices.legacy-proxy | warn | 4.1.0 | 5.0.0 | new-surface | Old surface is deprecated. | https://docs.lando.dev/deprecations/old-surface | plugin:legacy-plugin | 1",
    );
  });

  test("doctor --deprecations empty report states no deprecations were used at runtime", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await Effect.runPromise(
      doctorReport({ deprecations: true }).pipe(Effect.provide(buildLayers(provider))),
    );

    expect(report.deprecations?.entries).toEqual([]);
    expect(renderDoctorReport(report)).toContain(
      "No deprecations were used or triggered at runtime for the app.",
    );
  });

  test("doctor deprecation machine output exposes structured data independent of warning suppression", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    process.env.LANDO_DEPRECATION_WARNINGS = "0";
    try {
      const report = await Effect.runPromise(
        Effect.gen(function* () {
          yield* useDeprecation("env-override", "LANDO_LEGACY");
          return yield* doctorReport({ deprecations: true });
        }).pipe(Effect.provide(buildLayers(provider))),
      );

      const json = JSON.parse(renderDoctorReportAsJson(report)) as DoctorReport;
      expect(json.deprecations?.entries[0]).toMatchObject({ kind: "env-override", id: "LANDO_LEGACY" });

      const yaml = renderDoctorReportAsYaml(report);
      expect(yaml).toContain("deprecations:");
      expect(yaml).toContain("kind: env-override");
      expect(yaml).toContain("id: LANDO_LEGACY");

      const ndjson = renderDoctorReportAsNdjson(report, { now: new Date("1970-01-01T00:00:00.000Z") });
      const deprecations = eventPayloads(ndjson).find((line) => line.name === "deprecations");
      expect(deprecations).toMatchObject({
        _tag: "doctor.check",
        name: "deprecations",
        status: "pass",
        severity: "info",
        context: { entries: "1" },
      });
      expect(
        (deprecations?.entries as ReadonlyArray<Record<string, unknown>> | undefined)?.[0],
      ).toMatchObject({
        kind: "env-override",
        id: "LANDO_LEGACY",
        severity: "warn",
        count: 1,
      });
      expect(resultEnvelope(ndjson).result).toMatchObject({ checks: 10 });
    } finally {
      process.env.LANDO_DEPRECATION_WARNINGS = undefined;
    }
  });

  test("doctor deprecation json format stays parseable when info-level deprecations exist", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const io = createBufferedRendererIO();
    let exitCode = 0;

    await runWithRendererHandling(
      Effect.gen(function* () {
        yield* useDeprecation("command", "app:legacy", deprecationNotice({ severity: "info" }));
        return yield* doctorReport({ deprecations: true, format: "json" });
      }),
      {
        runtime: buildLayers(provider),
        rendererMode: "plain",
        io,
        suppressDeprecationDiagnostics: true,
        render: renderDoctorReportAsJson,
        formatError: (error) => String(error),
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    const parsed = JSON.parse(io.stdout()) as DoctorReport;
    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(parsed.deprecations?.entries[0]).toMatchObject({ kind: "command", id: "app:legacy" });
  });

  test("meta:doctor suppresses renderer diagnostics for machine output formats", () => {
    expect(
      metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { deprecations: true, format: "json" } }),
    ).toBe(true);
    expect(
      metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { deprecations: true, format: "yaml" } }),
    ).toBe(true);
    // Machine output must stay parseable even without --deprecations: post-run
    // deprecation diagnostics would otherwise contaminate JSON/YAML stdout.
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { format: "json" } })).toBe(true);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { format: "yaml" } })).toBe(true);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { deprecations: true } })).toBe(false);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { format: "text" } })).toBe(false);
  });
});
