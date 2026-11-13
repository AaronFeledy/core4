import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import * as DeprecationServiceLayer from "@lando/engine/deprecation/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import { createBufferedRendererIO } from "@lando/renderer/io";
import {
  AbsolutePath,
  CommandResultEnvelope,
  type DeprecationNotice,
  type DeprecationSurfaceKind,
  type GlobalConfig,
  ProviderId,
  StreamFrame,
} from "@lando/sdk/schema";
import { DeprecationService } from "@lando/sdk/services";
import { yamlRoundTripCorpus, yamlRoundTripRecord } from "@lando/sdk/test";
import { Cause, type Context, DateTime, Effect, Exit, Layer, Schema } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor.ts";
import { type DoctorOptions, doctor } from "../../src/cli/commands/doctor.ts";
import { UNRESOLVED_CERTS_STATUS } from "../../src/cli/commands/doctor-certs-status.ts";
import type { DoctorCheck, DoctorFinding, DoctorReport } from "../../src/cli/commands/doctor-contract.ts";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-contract.ts";
import { FilesystemWatchIO } from "../../src/cli/commands/doctor-filesystem-watch-io.ts";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson.ts";
import { renderDoctorReport } from "../../src/cli/commands/doctor-render-text.ts";
import {
  appConfigFindings,
  appConfigForReport,
  collectDoctorReport,
  deprecationFindings,
  doctorDeprecations,
  makeDoctorReport,
} from "../../src/cli/commands/doctor-report.ts";
import { appVersionConstraintsForReport } from "../../src/cli/commands/doctor-version-constraint.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { renderCompiledDoctorReport } from "../../src/cli/run.ts";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

const isolatedUserDataRoot = mkdtempSync(join(tmpdir(), "lando-doctor-report-"));

afterAll(async () => {
  await rm(isolatedUserDataRoot, { recursive: true, force: true });
});

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

const buildRegistry = (provider: typeof TestRuntimeProvider) =>
  RuntimeProviderRegistry.of({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

const buildConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Service.Shape<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return ConfigService.of({
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  });
};

const healthyFilesystemWatch = Layer.succeed(
  FilesystemWatchIO,
  FilesystemWatchIO.of({
    observe: Effect.succeed({
      limits: { max_user_watches: "65536", max_user_instances: "128", max_queued_events: "16384" },
      allocation: { stage: "complete" },
      cleanup: "complete",
      eventDelivery: "confirmed",
    }),
  }),
);

const buildLayers = (
  provider: typeof TestRuntimeProvider,
): Layer.Layer<
  ConfigService | PathsService | RuntimeProviderRegistry | DeprecationService | FilesystemWatchIO
> =>
  Layer.mergeAll(
    healthyFilesystemWatch,
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, ConfigService.of(buildConfigService())),
    Layer.succeed(
      PathsService,
      makeLandoPaths({ userDataRoot: isolatedUserDataRoot, platform: "linux", env: {} }),
    ),
    DeprecationServiceLayer.layer,
  );

const doctorReport = (options: DoctorOptions = {}) =>
  collectDoctorReport({
    options,
    provider: doctor(options, []),
    deprecations: doctorDeprecations(),
    appConfig: appConfigForReport().pipe(Effect.provide(PluginRegistryLayer.layer)),
  });

const run = (provider: typeof TestRuntimeProvider): Promise<DoctorReport> =>
  Effect.runPromise(doctorReport({ env: {} }).pipe(Effect.provide(buildLayers(provider))));

const check = (section: DoctorCheck["section"], input: DoctorFinding): DoctorCheck => ({
  section,
  ...input,
});

const deprecationNotice = (overrides: Partial<DeprecationNotice> = {}): DeprecationNotice => ({
  since: "4.1.0",
  severity: "warn",
  replacement: "new-surface",
  removeIn: "5.0.0",
  note: "Old surface is deprecated.",
  docsUrl: "https://docs.lando.dev/deprecations/old-surface",
  ...overrides,
});

const useDeprecation = Effect.fnUntraced(function* (
  kind: DeprecationSurfaceKind,
  id: string,
  notice = deprecationNotice(),
) {
  const deprecations = yield* DeprecationService;
  yield* deprecations.register("core", kind, id, notice);
  yield* deprecations
    .use({
      kind,
      id,
      notice,
      app: "doctor-app",
      ...(kind === "plugin" || kind === "manifest-contribution" ? { plugin: "legacy-plugin" } : {}),
      timestamp: DateTime.makeUnsafe("2026-06-13T00:00:00.000Z"),
    })
    .pipe(Effect.exit);
});

describe("meta:doctor combined report", () => {
  test("doctor keeps multiline lint suggestions attributed in text and narrow or wide TTY reports", async () => {
    const base = await run({ ...TestRuntimeProvider, id: "lando" });
    const suggestion = "Rewrite:\nx-demo:\n  a: 日本語\n\n";
    const report: DoctorReport = {
      ...base,
      checks: [
        ...base.checks,
        check("app-config", {
          name: "landofile.load",
          status: "fail",
          severity: "error",
          context: {
            file: "/app/.lando.yml",
            location: "(root)",
            message: "Use a block mapping.",
            line: "3",
            column: "3",
          },
          solutions: [{ kind: "manual", description: suggestion }],
          details: {
            rule: "landofile.load",
            severity: "error",
            path: [],
            message: "Use a block mapping.",
            suggestion,
            line: 3,
            column: 3,
          },
        }),
      ],
      summary: { ...base.summary, checks: base.summary.checks + 1, failed: base.summary.failed + 1 },
    };
    expect(renderDoctorReport(report, undefined, { all: true })).toContain("Rewrite:");
    for (const columns of [40, 120]) {
      const text = stripAnsi(
        renderDoctorReport(
          report,
          { mode: "lando", format: "text", isTTY: true, columns, noColor: false },
          { all: true },
        ),
      );
      expect(text).toContain("Rewrite:");
      expect(text).toContain("x-demo:");
      expect(text).toContain("日本語");
      for (const line of text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
    }
    const event = eventPayloads(renderDoctorReportAsNdjson(report)).find(
      (payload) => payload.name === "landofile.load",
    );
    expect((event?.details as { readonly message?: string } | undefined)?.message).toBe(
      "Use a block mapping.",
    );
  });

  test.each([false, true])("counts app-config findings alongside errors=%s", async (withError) => {
    const base = makeDoctorReport({
      version: "4.0.0-test",
      checks: [
        check("app-config", {
          name: "env-file.literal",
          status: "warn",
          severity: "warn",
          context: { file: "/app/.lando.yml", message: "Literal env warning" },
          solutions: [],
        }),
        ...(withError
          ? [
              check("app-config", {
                name: "env-file.read",
                status: "fail",
                severity: "error",
                context: { file: "/app/.lando.yml", message: "Missing env file" },
                solutions: [],
              }),
            ]
          : []),
      ],
      skipped: [],
    });
    const text = renderDoctorReport(base);
    expect(text).toContain("Literal env warning");
    const ndjson = renderDoctorReportAsNdjson(base);
    const payload = eventPayloads(ndjson).find((event) => event.name === "env-file.literal");
    expect(payload).toMatchObject({ status: "warn", severity: "warn" });
    expect(resultEnvelope(ndjson).result).toMatchObject({
      summary: { checks: withError ? 2 : 1, failed: withError ? 1 : 0, warned: 1 },
    });
  });

  test.each([
    { range: ">=0", skip: "0", status: "pass", severity: "info" },
    { range: ">=99", skip: "1", status: "warn", severity: "warn" },
    { range: ">=99", skip: "0", status: "fail", severity: "error" },
  ] as const)(
    "collector retains $status version checks when no runtime StateStore is provided",
    async (input) => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-collector-version-")));
      const previousCwd = process.cwd();
      const previousSkip = process.env.LANDO_SKIP_VERSION_CONSTRAINT;
      try {
        await writeFile(join(dir, ".lando.yml"), `name: doctor-app\nlando: '${input.range}'\n`);
        process.chdir(dir);
        process.env.LANDO_SKIP_VERSION_CONSTRAINT = input.skip;

        const report = await Effect.runPromise(
          collectDoctorReport({
            options: { app: true, env: {} },
            provider: Effect.succeed({ checks: [] }),
            deprecations: Effect.succeed({ entries: [] }),
            certs: Effect.succeed(UNRESOLVED_CERTS_STATUS),
            subsystems: () => Effect.succeed({ checks: [] }),
          }).pipe(
            Effect.provideService(
              ConfigService,
              ConfigService.of(buildConfigService({ userDataRoot: AbsolutePath.make(dir) })),
            ),
          ),
        );

        const versionChecks = report.checks.filter((entry) => entry.section === "app-version-constraints");
        expect(versionChecks).toHaveLength(1);
        expect(versionChecks[0]).toMatchObject({
          name: "app-version-constraint",
          status: input.status,
          severity: input.severity,
          context: { skipped: String(input.skip === "1") },
        });
        expect(report.checks.filter((entry) => entry.name === "doctor-self")).toEqual([]);
      } finally {
        process.chdir(previousCwd);
        if (previousSkip === undefined) Reflect.deleteProperty(process.env, "LANDO_SKIP_VERSION_CONSTRAINT");
        else process.env.LANDO_SKIP_VERSION_CONSTRAINT = previousSkip;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("aggregates inspected checks and skips runtime subsystems absent from the library runtime", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);

    expect(report.checks.find((entry) => entry.section === "provider")?.name).toBe("selected-provider");
    expect(report.checks.filter((entry) => entry.section === "subsystems")).toEqual([]);
    expect(report.checks.map((entry) => entry.section)).toEqual(
      expect.arrayContaining([
        "certificate-authority",
        "network-trust",
        "global-app",
        "mcp",
        "legacy-snapshot-catalogs",
        "filesystem-watch",
      ]),
    );
    expect(report.skipped).toContainEqual({
      section: "subsystems",
      reason: expect.any(String),
    });
    expect(report.checks.find((entry) => entry.section === "global-app")?.name).toBe("global-app");
    const mcp = report.checks.find((entry) => entry.section === "mcp");
    expect(mcp?.name).toBe("mcp");
    expect(mcp?.status).toBe("pass");
  });

  test("renderDoctorReport surfaces provider, every section, and global-app", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const text = renderDoctorReport(report, undefined, { all: true });

    expect(text).toContain("selected-provider: pass");
    for (const name of ["certificate-authority", "network-trust", "subsystems", "global-app"]) {
      expect(text).toContain(`${name}:`);
    }
    expect(text).toContain("lando global:reconcile");
    expect(text).not.toContain("[object Object]");
  });

  test("does not require app bootstrap — runs with only ConfigService + RuntimeProviderRegistry", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    expect(report.checks.map((entry) => [entry.section, entry.name])).toEqual([
      ["provider", "selected-provider"],
      ["provider", "runtime-service"],
      ["provider", "exec-umask"],
      ["certificate-authority", "certs"],
      ["network-trust", "network-trust"],
      ["global-app", "global-app"],
      ["mcp", "mcp"],
      ["legacy-snapshot-catalogs", "legacy-snapshot-catalogs"],
      ["filesystem-watch", "filesystem-watch"],
    ]);
  });

  test("global-app check reports not-installed when no userDataRoot is configured", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const globalApp = report.checks.find((entry) => entry.section === "global-app");
    expect(globalApp?.name).toBe("global-app");
    expect(globalApp?.status).toBe("warn");
    expect(globalApp?.context.installed).toBe("false");
    expect(globalApp?.solutions[0]?.command).toBe("lando global:reconcile");
  });

  test("the ndjson renderer emits every check and skip exactly once with a terminal summary", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const ndjson = renderDoctorReportAsNdjson(report);
    const frames = decodeFrames(ndjson);
    expect(
      frames.flatMap((frame) =>
        frame._tag === "event" && frame.event === "doctor.check" ? [frame.payload] : [],
      ),
    ).toEqual([...report.checks]);
    expect(
      frames.flatMap((frame) =>
        frame._tag === "event" && frame.event === "doctor.skip" ? [frame.payload] : [],
      ),
    ).toEqual([...report.skipped]);
    expect(frames.length).toBe(report.checks.length + report.skipped.length + 1);
    expect(resultEnvelope(ndjson)).toMatchObject({
      command: "meta:doctor",
      ok: true,
      result: { version: report.version, summary: report.summary },
    });
  });

  test("--format=json keeps the full report and --format=ndjson is a stream", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(report), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "meta:doctor",
      resultSchema: DoctorReportSchema,
      io,
      render: (value, ctx) => renderCompiledDoctorReport(value, ctx),
      formatError: ({ error }) => String(error),
    });
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
    expect(envelope.result).toEqual(Schema.encodeSync(DoctorReportSchema)(report));
    expect(metaDoctorSpec.completion?.(report, {})).toEqual({ ok: true, exitCode: 0 });
    const stream = renderCompiledDoctorReport(report, {
      mode: "plain",
      format: "ndjson",
      columns: 80,
      isTTY: false,
      noColor: false,
    });
    expect(stream).toBeDefined();
    expect(decodeFrames(stream ?? "")[0]).toMatchObject({ _tag: "event", event: "doctor.check" });
    expect(resultEnvelope(stream ?? "").result).toMatchObject({ summary: report.summary });
  });

  test("maps deprecations to one finding per entry with severity status", () => {
    const findings = deprecationFindings({
      entries: [
        {
          kind: "command",
          id: "app:legacy",
          severity: "error",
          since: "4.1.0",
          note: "Old command is not supported.",
          source: "app:demo",
          count: 2,
        },
        {
          kind: "flag",
          id: "legacy-flag",
          severity: "warn",
          since: "4.1.0",
          note: "Rename the flag.",
          source: "app:demo",
          count: 1,
        },
        {
          kind: "service-type",
          id: "mailhog",
          severity: "info",
          since: "4.1.0",
          note: "Use Mailpit.",
          source: "core",
          count: 3,
        },
      ],
    });
    expect(findings.map((entry) => [entry.name, entry.status, entry.severity])).toEqual([
      ["deprecation", "fail", "error"],
      ["deprecation", "warn", "warn"],
      ["deprecation", "pass", "info"],
    ]);
    expect(findings[0]?.context.count).toBe("2");
    expect(findings[0]?.solutions).toEqual([
      { kind: "manual", description: "Old command is not supported." },
    ]);
  });

  test("records runtime deprecations once per entry and keeps the summary aligned", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* useDeprecation("command", "app:legacy", deprecationNotice({ severity: "error" }));
        return yield* doctorReport({ env: {}, deprecations: true, flagProviderId: provider.id });
      }).pipe(Effect.provide(buildLayers(provider))),
    );
    const deprecations = report.checks.filter((entry) => entry.section === "deprecations");
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0]).toMatchObject({ status: "fail", severity: "error" });
    expect(report.summary.failed).toBe(1);
    expect(report.summary.checks).toBe(report.checks.length);
  });

  test("a clean app config yields one passing app-config-lint finding with the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-doctor-clean-"));
    try {
      await writeFile(join(dir, ".lando.yml"), "name: doctor-app\n");
      const result = await withCwd(dir, () =>
        Effect.runPromise(appConfigForReport().pipe(Effect.provide(PluginRegistryLayer.layer))),
      );
      expect(appConfigFindings(result)).toEqual([
        {
          name: "app-config-lint",
          status: "pass",
          severity: "info",
          context: { file: join(dir, ".lando.yml") },
          solutions: [],
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("version constraint producer returns undefined with no Landofile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-doctor-version-none-"));
    try {
      expect(await withCwd(dir, () => Effect.runPromise(appVersionConstraintsForReport()))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a user interrupt in the non-isolated listeners section as an interrupt", async () => {
    // Given the listeners slot, which owns its isolation, yielding a user interrupt
    // When the runner executes it
    const exit = await Effect.runPromiseExit(
      collectDoctorReport({
        options: { env: {}, app: true },
        provider: Effect.succeed({ checks: [] }),
        listeners: () => Effect.interrupt,
        deprecations: Effect.succeed({ entries: [] }),
        certs: Effect.succeed(UNRESOLVED_CERTS_STATUS),
      }).pipe(Effect.provide(buildLayers(TestRuntimeProvider))),
    );

    // Then the run is interrupted, not failed with a defect or degraded to a self finding
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
    }
  });

  test("report schema requires version", () => {
    expect(() =>
      Schema.decodeUnknownSync(DoctorReportSchema)({
        checks: [],
        skipped: [],
        summary: { checks: 0, passed: 0, warned: 0, failed: 0 },
      }),
    ).toThrow();
  });

  test("combined ndjson renderer emits provider, certificate-authority, network-trust, and global-app checks in one stream", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const ndjson = renderDoctorReportAsNdjson(report);
    const checks = eventPayloads(ndjson);

    expect(checks.map((entry) => entry.section)).toEqual(
      expect.arrayContaining(["provider", "certificate-authority", "network-trust", "global-app"]),
    );
    expect(checks.map((entry) => entry.name)).toEqual(report.checks.map((entry) => entry.name));
    expect(resultEnvelope(ndjson)).toMatchObject({
      command: "meta:doctor",
      ok: true,
      result: { version: report.version, summary: report.summary },
    });
  });

  test("compiled doctor renderer dispatches ndjson format through the StreamFrame renderer", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);
    const ndjson = renderCompiledDoctorReport(report, {
      noColor: false,
      mode: "lando",
      format: "ndjson",
      columns: 80,
      isTTY: false,
    });

    if (ndjson === undefined) throw new Error("expected compiled doctor renderer output");
    expect(decodeFrames(ndjson)[0]).toMatchObject({ _tag: "event", event: "doctor.check" });
    expect(ndjson).not.toContain("selected-provider: pass");
  });

  test("doctor --app reports an unsatisfied lando version constraint", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-version-")));
    await writeFile(join(dir, ".lando.yml"), "name: doctor-app\nlando: >=99\n");
    try {
      const report = await withCwd(dir, () =>
        Effect.runPromise(doctorReport({ app: true, env: {} }).pipe(Effect.provide(buildLayers(provider)))),
      );

      const version = report.checks.find((entry) => entry.section === "app-version-constraints");
      expect(version).toMatchObject({
        name: "app-version-constraint",
        status: "fail",
        severity: "error",
        context: {
          runningVersion: "0.0.0",
          unsatisfied: ">=99 (canonical#3: .lando.yml)",
          skipped: "false",
        },
      });
      expect(renderDoctorReport(report)).toContain("app-version-constraint: fail");
      const ndjson = renderDoctorReportAsNdjson(report);
      expect(eventPayloads(ndjson).map((entry) => entry.name)).toContain("app-version-constraint");
      expect(resultEnvelope(ndjson).result).toMatchObject({
        summary: expect.objectContaining({ failed: 1 }),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor --app reports an unsatisfied lando version constraint from .lando.ts", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-version-ts-")));
    await writeFile(
      join(dir, ".lando.ts"),
      ["export default {", '  name: "doctor-ts-app",', '  lando: ">=99",', "};", ""].join("\n"),
    );
    try {
      const report = await withCwd(dir, () =>
        Effect.runPromise(doctorReport({ app: true, env: {} }).pipe(Effect.provide(buildLayers(provider)))),
      );

      expect(report.checks.find((entry) => entry.section === "app-version-constraints")).toMatchObject({
        name: "app-version-constraint",
        status: "fail",
        severity: "error",
        context: {
          runningVersion: "0.0.0",
          unsatisfied: ">=99 (canonical#3: .lando.ts)",
          skipped: "false",
        },
      });
      expect(renderDoctorReport(report)).toContain("app-version-constraint: fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([1, 2])("doctor --app reports all %s unresolved includes", async (count) => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-version-include-")));
    await writeFile(
      join(dir, ".lando.yml"),
      ["name: doctor-app", "includes:", "  - ./missing.yml", ""].join("\n"),
    );
    if (count === 2) await writeFile(join(dir, ".lando.local.yml"), "includes: [./also-missing.yml]\n");
    try {
      const report = await withCwd(dir, () =>
        Effect.runPromise(doctorReport({ app: true, env: {} }).pipe(Effect.provide(buildLayers(provider)))),
      );

      const version = report.checks.find((entry) => entry.section === "app-version-constraints");
      expect(version).toMatchObject({
        name: "app-version-constraint",
        status: "fail",
        severity: "error",
        context: { declared: count === 1 ? "(unresolved includes)" : "(Landofile load failures)" },
      });
      expect(version?.context.includeResolution).toContain("missing.yml");
      if (count === 1) expect(renderDoctorReport(report)).toContain("lando app:includes:update");
      else expect(version?.context.includeResolution).toContain("also-missing.yml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports a malformed lando range as a redacted version-constraint failure", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-version-malformed-")));
    const secret = "definitely-not-semver-secret";
    await writeFile(join(dir, ".lando.yml"), `name: doctor-app\nlando: ${secret}\n`);
    try {
      const result = await withEnvVar("LANDO_SECRET_MALFORMED_RANGE", secret, () =>
        withCwd(dir, () => Effect.runPromise(appVersionConstraintsForReport())),
      );
      if (result === undefined) throw new Error("expected version-constraint report");
      const report = makeDoctorReport({
        checks: result.checks.map((finding) => check("app-version-constraints", finding)),
        skipped: [],
      });

      expect(report.checks[0]).toMatchObject({
        name: "app-version-constraint",
        status: "fail",
        severity: "error",
        context: { declared: "(malformed Landofile)" },
        solutions: [
          {
            kind: "manual",
            description: "Fix the Landofile syntax or `lando:` range, then rerun `lando doctor --app`.",
          },
        ],
      });
      expect(report.checks[0]?.context.loadFailure).toContain("not a valid semver range");
      const text =
        metaDoctorSpec.render?.(
          report,
          { flags: { format: "text" } },
          { mode: "plain", format: "text", columns: 80, isTTY: false, noColor: false },
        ) ?? "";
      expect(text).toContain("app-version-constraint: fail");
      expect(text).toContain("Fix the Landofile syntax or `lando:` range");
      expect(text).not.toContain(secret);
      expect(report.checks[0]?.context.loadFailure).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports same-layer YAML and TypeScript forms as a redacted version-constraint failure", async () => {
    const secret = "doctor-form-secret";
    const dir = await realpath(await mkdtemp(join(tmpdir(), "doctor-form-secret-")));
    await writeFile(join(dir, ".lando.yml"), "name: doctor-app\n");
    await writeFile(join(dir, ".lando.local.yml"), "name: local-yaml\n");
    await writeFile(join(dir, ".lando.local.ts"), 'export default { name: "local-ts" };\n');
    try {
      const result = await withEnvVar("LANDO_SECRET_CONFLICT_PATH", secret, () =>
        withCwd(dir, () => Effect.runPromise(appVersionConstraintsForReport())),
      );
      if (result === undefined) throw new Error("expected version-constraint report");
      const report = makeDoctorReport({
        checks: result.checks.map((finding) => check("app-version-constraints", finding)),
        skipped: [],
      });

      expect(report.checks[0]).toMatchObject({
        name: "app-version-constraint",
        status: "fail",
        severity: "error",
        context: { declared: "(conflicting Landofile forms)", layer: "local" },
      });
      expect(report.checks[0]?.context.loadFailure).toContain("are present for the local Landofile layer");
      expect(report.checks[0]?.solutions[0]?.description).toContain("each layer accepts exactly one form");
      const text =
        metaDoctorSpec.render?.(
          report,
          { flags: { format: "text" } },
          { mode: "plain", format: "text", columns: 80, isTTY: false, noColor: false },
        ) ?? "";
      expect(text).toContain("app-version-constraint: fail");
      expect(text).toContain("each layer accepts exactly one form");
      expect(text).not.toContain(secret);
      expect(report.checks[0]?.context.loadFailure).not.toContain(secret);
      expect(report.checks[0]?.solutions[0]?.description).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor --app reports the invocation-scoped version-constraint skip", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-version-skip-")));
    await writeFile(join(dir, ".lando.yml"), "name: doctor-app\nlando: >=99\n");
    try {
      const report = await withEnvVar("LANDO_SKIP_VERSION_CONSTRAINT", "1", () =>
        withCwd(dir, () =>
          Effect.runPromise(doctorReport({ app: true, env: {} }).pipe(Effect.provide(buildLayers(provider)))),
        ),
      );

      expect(report.checks.find((entry) => entry.section === "app-version-constraints")).toMatchObject({
        name: "app-version-constraint",
        status: "warn",
        severity: "warn",
        context: { skipped: "true", unsatisfied: ">=99 (canonical#3: .lando.yml)" },
      });
      expect(renderDoctorReport(report)).toContain("LANDO_SKIP_VERSION_CONSTRAINT=1 is active");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor --app redacts templated secret values in version constraints", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-version-redact-")));
    const secret = ">=99.0.0";
    await writeFile(
      join(dir, ".lando.yml"),
      ["template: handlebars", "name: doctor-app", "lando: {{ env.LANDO_SECRET_VERSION_RANGE }}", ""].join(
        "\n",
      ),
    );
    try {
      const report = await withEnvVar("LANDO_SECRET_VERSION_RANGE", secret, () =>
        withCwd(dir, () =>
          Effect.runPromise(doctorReport({ app: true, env: {} }).pipe(Effect.provide(buildLayers(provider)))),
        ),
      );

      const text =
        metaDoctorSpec.render?.(
          report,
          { flags: { format: "text" } },
          { mode: "plain", format: "text", columns: 80, isTTY: false, noColor: false },
        ) ?? "";
      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed(report), {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "yaml",
        command: "meta:doctor",
        resultSchema: DoctorReportSchema,
        io,
        render: () => undefined,
        formatError: ({ error }) => String(error),
      });
      const yaml = io.stdout();
      expect((Bun.YAML.parse(yaml) as { readonly result: DoctorReport }).result.checks).toEqual(
        report.checks,
      );
      const ndjson = renderDoctorReportAsNdjson(report);

      expect(text).not.toContain(secret);
      expect(yaml).not.toContain(secret);
      expect(ndjson).not.toContain(secret);
      expect(
        report.checks.find((entry) => entry.section === "app-version-constraints")?.context.unsatisfied,
      ).not.toContain(secret);
    } finally {
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
        return yield* doctorReport({ deprecations: true, env: {} });
      }).pipe(Effect.provide(buildLayers(provider))),
    );

    const findings = report.checks.filter((entry) => entry.section === "deprecations");
    expect(findings.map((entry) => `${entry.context.kind}:${entry.context.id}`)).toContain(
      "command:app:legacy",
    );
    expect(findings).toHaveLength(8);
    expect(findings.find((entry) => entry.context.kind === "command")).toMatchObject({
      context: {
        id: "app:legacy",
        since: "4.1.0",
        removeIn: "5.0.0",
        replacement: "new-surface",
        docsUrl: "https://docs.lando.dev/deprecations/old-surface",
        source: "app:doctor-app",
        count: "2",
      },
      solutions: [{ kind: "manual", description: "Old surface is deprecated." }],
    });

    const text = renderDoctorReport(report);
    expect(text).toContain("deprecations:");
    expect(text).toContain("kind: command");
    expect(text).toContain("id: app:legacy");
    expect(text).toContain("manifest-contribution");
    expect(text).toContain("id: globalServices.legacy-proxy");
  });

  test("doctor --deprecations labels plugin-scoped entries by plugin when app context is also present", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* useDeprecation("manifest-contribution", "legacy-plugin:globalServices.legacy-proxy");
        return yield* doctorReport({ deprecations: true, env: {} });
      }).pipe(Effect.provide(buildLayers(provider))),
    );

    const finding = report.checks.find((entry) => entry.section === "deprecations");
    expect(finding).toMatchObject({
      context: { kind: "manifest-contribution", id: "legacy-plugin:globalServices.legacy-proxy" },
    });
    expect(finding?.context.source).toBe("plugin:legacy-plugin");
    expect(renderDoctorReport(report)).toContain("source: plugin:legacy-plugin");
  });

  test("doctor --deprecations empty report states no deprecations were used at runtime", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await Effect.runPromise(
      doctorReport({ deprecations: true, env: {} }).pipe(Effect.provide(buildLayers(provider))),
    );

    expect(report.checks.filter((entry) => entry.section === "deprecations")).toEqual([]);
    expect(renderDoctorReport(report, undefined, { all: true })).not.toContain("deprecations:");
  });

  test("doctor --deprecations finds type: mailhog when invoked from a subdirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mailhog-doctor-nested-"));
    await writeFile(join(dir, ".lando.yml"), "name: legacy-mail\nservices:\n  inbox:\n    type: mailhog\n");
    const nested = join(dir, "web");
    await mkdir(nested);
    try {
      const report = await withCwd(nested, () =>
        Effect.runPromise(
          doctorDeprecations().pipe(
            Effect.provide(Layer.mergeAll(DeprecationServiceLayer.layer, BunFileSystem.layer)),
          ),
        ),
      );
      expect(report.entries).toEqual([
        expect.objectContaining({
          kind: "service-type",
          id: "mailhog",
          since: "4.2.0",
          removeIn: "5.0.0",
          replacement: "mailpit",
          count: 1,
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor deprecation machine output exposes structured data independent of warning suppression", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    await withEnvVar("LANDO_DEPRECATION_WARNINGS", "0", async () => {
      const report = await Effect.runPromise(
        Effect.gen(function* () {
          yield* useDeprecation("env-override", "LANDO_LEGACY");
          return yield* doctorReport({ deprecations: true, env: {} });
        }).pipe(Effect.provide(buildLayers(provider))),
      );

      const encoded = Schema.decodeUnknownSync(DoctorReportSchema)(
        Schema.encodeSync(DoctorReportSchema)(report),
      );
      const encodedFinding = encoded.checks.find((entry) => entry.section === "deprecations");
      expect(encodedFinding).toMatchObject({ context: { kind: "env-override", id: "LANDO_LEGACY" } });

      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed(report), {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "yaml",
        command: "meta:doctor",
        resultSchema: DoctorReportSchema,
        io,
        render: () => undefined,
        formatError: ({ error }) => String(error),
      });
      const yaml = io.stdout();
      expect(yaml).toContain("kind: env-override");
      expect(yaml).toContain("id: LANDO_LEGACY");
      const yamlFinding = (Bun.YAML.parse(yaml) as { readonly result: DoctorReport }).result.checks.find(
        (entry) => entry.section === "deprecations",
      );
      expect(yamlFinding).toMatchObject({ context: { kind: "env-override", id: "LANDO_LEGACY" } });

      const ndjson = renderDoctorReportAsNdjson(report);
      const deprecation = eventPayloads(ndjson).find((entry) => entry.name === "deprecation");
      expect(deprecation).toMatchObject({
        name: "deprecation",
        status: "warn",
        severity: "warn",
        context: { kind: "env-override", id: "LANDO_LEGACY", count: "1" },
      });
      const summary = (resultEnvelope(ndjson).result as { readonly summary: DoctorReport["summary"] })
        .summary;
      expect(summary).toEqual(report.summary);
      expect(summary.checks).toBe(report.checks.length);
    });
  });

  test("doctor deprecation json format stays parseable when info-level deprecations exist", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const io = createBufferedRendererIO();
    let exitCode = 0;
    let renderCalled = false;

    await runWithRendererHandling(
      Effect.gen(function* () {
        yield* useDeprecation("command", "app:legacy", deprecationNotice({ severity: "info" }));
        return yield* doctorReport({ deprecations: true, env: {} });
      }),
      {
        runtime: buildLayers(provider),
        rendererMode: "json",
        resultFormat: "json",
        command: "meta:doctor",
        resultSchema: DoctorReportSchema,
        io,
        suppressDeprecationDiagnostics: true,
        render: () => {
          renderCalled = true;
          return "legacy-json-renderer";
        },
        formatError: ({ error }) => String(error),
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    const parsed = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdoutLines()[0] ?? "{}"));
    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(renderCalled).toBe(false);
    expect(
      (parsed.result as DoctorReport).checks.find((entry) => entry.section === "deprecations"),
    ).toMatchObject({ context: { kind: "command", id: "app:legacy" }, status: "pass", severity: "info" });
  });

  test("meta:doctor suppresses renderer diagnostics for machine output formats", () => {
    expect(
      metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { deprecations: true, format: "json" } }),
    ).toBe(true);
    expect(
      metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { deprecations: true, format: "yaml" } }),
    ).toBe(true);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { format: "json" } })).toBe(true);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { format: "yaml" } })).toBe(true);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { deprecations: true } })).toBe(false);
    expect(metaDoctorSpec.suppressDeprecationDiagnostics?.({ flags: { format: "text" } })).toBe(false);
  });

  test("doctor preserves boolean buildSecrets capability in redacted text and JSON output", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, buildSecrets: true },
    };
    const report = await run(provider);

    const textIo = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(report), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "text",
      command: "meta:doctor",
      resultSchema: metaDoctorSpec.resultSchema,
      io: textIo,
      render: (value, ctx) => renderDoctorReport(value, ctx, { all: true }),
      formatError: ({ error }) => String(error),
    });
    expect(textIo.stdoutLines().join("")).toContain("buildSecrets: true");
    expect(textIo.stdoutLines().join("")).not.toContain("buildSecrets: [redacted]");

    const jsonIo = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(report), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "meta:doctor",
      resultSchema: metaDoctorSpec.resultSchema,
      io: jsonIo,
      render: renderDoctorReport,
      formatError: ({ error }) => String(error),
    });
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
      JSON.parse(jsonIo.stdoutLines()[0] ?? "{}"),
    );
    expect(envelope.ok).toBe(true);
    const result = Schema.decodeUnknownSync(DoctorReportSchema)(envelope.result);
    expect(result.provider?.capabilities?.buildSecrets).toBe(true);
  });

  test("doctor receives unknown event violations from the shared lint pass", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-event-")));
    await writeFile(join(dir, ".lando.yml"), "name: doctor-events\nevents:\n  pre-nope: [echo hi]\n");
    try {
      const result = await withCwd(dir, () =>
        Effect.runPromise(appConfigForReport().pipe(Effect.provide(PluginRegistryLayer.layer))),
      );
      expect(result.app).toBe("doctor-events");
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.event",
          path: ["events", "pre-nope"],
          scopes: ["effective"],
          source: expect.objectContaining({ file: join(dir, ".lando.yml") }),
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctorReport runs the shared app:config:lint pass and renders it under --app", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-doctor-app-")));
    await writeFile(join(dir, ".lando.yml"), "name: doctor-app\nbogusKey: nope\n");
    try {
      const report = await withCwd(dir, () =>
        Effect.runPromise(doctorReport({ app: true, env: {} }).pipe(Effect.provide(buildLayers(provider)))),
      );

      const appConfig = report.checks.find((entry) => entry.section === "app-config");
      expect(appConfig).toBeDefined();
      expect(appConfig?.status).toBe("fail");
      expect(
        appConfig?.details !== undefined && "path" in appConfig.details ? appConfig.details.path : undefined,
      ).toContain("bogusKey");

      const text = renderDoctorReport(report);
      expect(text).toContain("app-config:");
      expect(text).toContain("bogusKey");

      const ndjson = renderDoctorReportAsNdjson(report);
      expect(
        eventPayloads(ndjson)
          .filter((event) => event.section === "app-config")
          .map((event) => event.name),
      ).toContain("landofile.validation");
      expect(resultEnvelope(ndjson).result).toMatchObject({
        summary: expect.objectContaining({ failed: 1 }),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([false, true])("renders canonical env warnings alongside errors=%s", async (withError) => {
    const result = {
      app: "env",
      file: "/app/.lando.yml",
      valid: !withError,
      violations: [
        {
          rule: "env-file.literal" as const,
          severity: "warning" as const,
          path: ["env_file", 0],
          message: "Literal env warning",
        },
        ...(withError
          ? [
              {
                rule: "env-file.read" as const,
                severity: "error" as const,
                path: ["env_file", 1],
                message: "Missing env file",
              },
            ]
          : []),
      ],
    };
    const report = makeDoctorReport({
      version: "4.0.0-test",
      checks: appConfigFindings(result).map((finding) => check("app-config", finding)),
      skipped: [],
    });
    const text = renderDoctorReport(report);
    expect(text).toContain("env-file.literal: warn");
    expect(text).toContain("Literal env warning");
    const decorated = renderDoctorReport(report, {
      noColor: false,
      mode: "lando",
      format: "text",
      isTTY: true,
      columns: 100,
    });
    expect(stripAnsi(decorated)).toContain("Literal env warning");
    const ndjson = renderDoctorReportAsNdjson(report);
    const payload = eventPayloads(ndjson).find((event) => event.name === "env-file.literal");
    expect(payload).toMatchObject({
      status: "warn",
      severity: "warn",
      details: { message: "Literal env warning" },
    });
    expect(payload).not.toHaveProperty("warnings");
    expect(resultEnvelope(ndjson).result).toMatchObject({
      summary: { checks: withError ? 2 : 1, failed: withError ? 1 : 0, warned: 1 },
    });
  });

  test("doctor yaml report round-trips danger-corpus strings through Bun.YAML.parse", async () => {
    const context = yamlRoundTripRecord();
    const solutions = yamlRoundTripCorpus.map((description) => ({
      kind: "manual" as const,
      description,
    }));
    const report = makeDoctorReport({
      version: "4.0.0-test",
      checks: [
        check("subsystems", {
          name: "yaml-round-trip",
          status: "warn",
          severity: "warn",
          context,
          solutions,
        }),
      ],
      skipped: [],
    });

    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(report), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "yaml",
      command: "meta:doctor",
      resultSchema: DoctorReportSchema,
      io,
      render: () => undefined,
      formatError: ({ error }) => String(error),
    });

    expect((Bun.YAML.parse(io.stdout()) as { readonly result: DoctorReport }).result.checks[0]).toMatchObject(
      { context, solutions },
    );
    const ctx = {
      mode: "plain",
      format: "yaml",
      columns: undefined,
      isTTY: false,
      noColor: false,
    } as const;
    expect(metaDoctorSpec.render?.(report, { flags: { format: "yaml" } }, ctx)).toBe(
      renderDoctorReport(report, ctx),
    );
    expect(renderCompiledDoctorReport(report, ctx)).toBe(renderDoctorReport(report, ctx));
  });

  test("meta:doctor json renderer emits the schema-encoded command result envelope", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const report = await run(provider);

    const io = createBufferedRendererIO();
    let renderCalled = false;
    await runWithRendererHandling(Effect.succeed(report), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "meta:doctor",
      resultSchema: metaDoctorSpec.resultSchema,
      io,
      render: () => {
        renderCalled = true;
        return renderDoctorReport(report);
      },
      formatError: ({ error }) => String(error),
    });

    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdoutLines()[0] ?? "{}"));
    expect(envelope).toMatchObject({ apiVersion: "v4", command: "meta:doctor", ok: true });
    expect(envelope.result).toEqual(Schema.encodeSync(DoctorReportSchema)(report));
    expect(io.stderr()).toBe("");
    expect(renderCalled).toBe(false);
  });
});
