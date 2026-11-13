import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRuntimeProvider } from "@lando/core/testing";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { GlobalConfigSnapshot, GlobalConfigSources } from "@lando/engine/services/config";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { GlobalConfig, ProviderId, StreamFrame } from "@lando/sdk/schema";
import { ConfigService, PathsService, PluginRegistry, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor.ts";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap.ts";
import type { DoctorReport } from "../../src/cli/commands/doctor-contract.ts";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-contract.ts";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson.ts";
import { buildDoctorReportSummary, renderDoctorReport } from "../../src/cli/commands/doctor-render-text.ts";
import { doctorCompletion, makeDoctorReport } from "../../src/cli/commands/doctor-report.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { resources } from "../../src/mcp-resources.ts";

const registryFor = (provider: typeof TestRuntimeProvider) =>
  RuntimeProviderRegistry.of({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

describe("doctor regressions", () => {
  test("a bad hostEvents config exits 1 with ok:true and a Problems found title", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-doctor-host-events-"));
    try {
      const config = Schema.decodeUnknownSync(GlobalConfig)({
        userDataRoot: root,
        hostEvents: { "pre-start": ["echo ${TOKEN}"] },
      });
      const paths = makeLandoPaths({
        userDataRoot: root,
        userConfRoot: join(root, "config"),
        userCacheRoot: join(root, "cache"),
        env: {},
      });
      const snapshot = GlobalConfigSnapshot.of({
        config,
        inputs: { env: {}, sources: { user: false, env: false }, rootOverrides: { userDataRoot: root } },
        paths,
        warnings: [],
        takeWarnings: Effect.succeed([]),
      });
      const sources = GlobalConfigSources.of({
        env: {},
        sources: { user: false, env: false },
        rootOverrides: { userDataRoot: root },
        snapshot,
      });
      const runtimeLayer = Layer.mergeAll(
        Layer.succeed(
          ConfigService,
          ConfigService.of({
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
        ),
        Layer.succeed(PathsService, paths),
        Layer.succeed(RuntimeProviderRegistry, registryFor(TestRuntimeProvider)),
        Layer.succeed(
          PluginRegistry,
          PluginRegistry.of({
            list: Effect.succeed([]),
            load: () => Effect.die("unused"),
            loadServiceType: () => Effect.die("unused"),
            loadServiceFeature: () => Effect.die("unused"),
            loadAppFeature: () => Effect.die("unused"),
          }),
        ),
      );
      const factory = Layer.succeed(
        RuntimeLayerFactory,
        RuntimeLayerFactory.of({ make: () => runtimeLayer }),
      );
      const report = await Effect.runPromise(
        resilientDoctorReport({ env: {}, flagProviderId: TestRuntimeProvider.id }).pipe(
          Effect.provide(Layer.merge(factory, Layer.succeed(GlobalConfigSources, sources))),
        ),
      );

      const globalConfig = report.checks.find((check) => check.section === "global-config");
      expect(globalConfig).toMatchObject({ status: "fail", details: { _tag: "ConfigError" } });
      expect(report.checks.filter((check) => check.name === "doctor-self")).toEqual([]);
      expect(metaDoctorSpec.completion?.(report, {})).toEqual({ ok: true, exitCode: 1 });
      expect(buildDoctorReportSummary(report).title).toBe("Problems found");
      expect(renderDoctorReport(report)).toContain("global-config: fail");
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();

      // The renderer boundary hands NDJSON a redacted copy of the report; the
      // ConfigError evidence must survive it as data.
      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed(report), {
        runtime: Layer.succeed(RedactionService, RedactionService.of(makeRedactionService())),
        rendererMode: "plain",
        resultFormat: "ndjson",
        command: "meta:doctor",
        resultSchema: DoctorReportSchema,
        io,
        render: (value) => renderDoctorReportAsNdjson(value),
        formatError: ({ error }) => String(error),
      });
      const frames = io
        .stdout()
        .trimEnd()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
      const globalConfigFrame = frames.find(
        (frame) =>
          frame._tag === "event" &&
          (frame.payload as { readonly section?: string }).section === "global-config",
      );
      expect(globalConfigFrame).toMatchObject({
        event: "doctor.check",
        payload: {
          status: "fail",
          details: { _tag: "ConfigError", message: expect.stringContaining("hostEvents") },
        },
      });
      expect(frames.at(-1)?._tag).toBe("result");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("text footer, ndjson summary, and completion agree for deprecation and app-config findings", () => {
    const checks = [
      {
        section: "deprecations" as const,
        name: "deprecation",
        status: "fail" as const,
        severity: "error" as const,
        context: { kind: "command", id: "app:legacy", since: "4.1.0", source: "app:demo", count: "1" },
        solutions: [{ kind: "manual" as const, description: "Stop using app:legacy." }],
      },
      {
        section: "deprecations" as const,
        name: "deprecation",
        status: "warn" as const,
        severity: "warn" as const,
        context: { kind: "flag", id: "legacy-flag", since: "4.1.0", source: "app:demo", count: "2" },
        solutions: [{ kind: "manual" as const, description: "Rename the flag." }],
      },
      {
        section: "app-config" as const,
        name: "env-file.literal",
        status: "warn" as const,
        severity: "warn" as const,
        context: { file: "/app/.lando.yml", message: "Literal env warning" },
        solutions: [],
      },
    ];
    const report: DoctorReport = makeDoctorReport({ version: "4.0.0-test", checks, skipped: [] });

    expect(report.summary).toEqual({ checks: 3, passed: 0, warned: 2, failed: 1, selfFailed: 0 });
    const text = renderDoctorReport(report);
    expect(text).toContain("3 checks · 1 failed · 2 warnings");
    const ndjson = renderDoctorReportAsNdjson(report);
    const frames = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
    expect(frames.at(-1)).toMatchObject({
      _tag: "result",
      envelope: { ok: true, result: { summary: { checks: 3, warned: 2, failed: 1 } } },
    });
    expect(metaDoctorSpec.completion?.(report, {})).toEqual({ ok: true, exitCode: 1 });
  });

  test("the real lando://doctor MCP resource uses the DoctorReport schema", () => {
    const doctor = resources.find((resource) => resource.uri === "lando://doctor");
    expect(doctor?.resultSchema).toBe(DoctorReportSchema);
  });

  test("a doctor-self finding is ok:false in both the command completion and the ndjson terminal frame", () => {
    const report = makeDoctorReport({
      version: "4.0.0-test",
      checks: [
        {
          section: "provider",
          name: "doctor-self",
          status: "fail",
          severity: "error",
          context: { probe: "provider-status", reason: "timeout", message: "slow" },
          solutions: [{ kind: "manual", description: "Retry." }],
        },
      ],
      skipped: [],
    });

    expect(doctorCompletion(report)).toEqual({ ok: false, exitCode: 1 });
    expect(metaDoctorSpec.completion?.(report, {})).toEqual({ ok: false, exitCode: 1 });
    const frames = renderDoctorReportAsNdjson(report)
      .trimEnd()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
    expect(frames.at(-1)).toMatchObject({
      _tag: "result",
      envelope: {
        ok: false,
        error: { _tag: "LandoCommandError" },
        result: { summary: { checks: 1, failed: 1 } },
      },
    });
  });
});
