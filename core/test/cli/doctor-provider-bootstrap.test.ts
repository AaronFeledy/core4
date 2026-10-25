import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { makeLandoPaths } from "@lando/paths";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ConfigError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { PathsService, StateStore } from "@lando/sdk/services";
import * as StateStoreService from "@lando/state-store/service";
import { Effect, Layer, Schema } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";
import {
  DoctorReportSchema,
  buildDoctorReportSummary,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../src/cli/commands/doctor-report";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { withCwd } from "../_support/temp-cwd";

describe("doctor provider-bootstrap failure", () => {
  test.each([false, true])("preserves independent diagnostics when fix=%s", async (fix) => {
    // Given valid global config and an app, but a provider runtime that cannot build.
    const root = await mkdtemp(join(tmpdir(), "lando-doctor-provider-bootstrap-"));
    await writeFile(join(root, ".lando.yml"), "name: doctor-app\nlando: '>=0'\n");
    const roots = {
      userConfRoot: join(root, "conf"),
      userDataRoot: join(root, "data"),
      userCacheRoot: join(root, "cache"),
    };
    const paths = makeLandoPaths({ ...roots, env: {} });
    const factory = Layer.succeed(
      RuntimeLayerFactory,
      RuntimeLayerFactory.of({
        make: <Services>(): Layer.Layer<Services, ConfigError> =>
          Layer.effectContext(Effect.fail(new ConfigError({ message: "Injected runtime build failure" }))),
      }),
    );
    try {
      await mkdir(join(paths.snapshotsDir, "old-app"), { recursive: true });
      await writeFile(join(paths.snapshotsDir, "old-app", "index.bin"), "{}");
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* StateStore;
          const bucket = yield* store.open({
            root: "userData",
            namespace: "accelerated-starts",
            key: `${"b".repeat(64)}.json`,
            schema: Schema.Unknown,
            version: 1,
          });
          yield* bucket.set({
            attemptId: "host-attempt",
            appId: "host-app",
            appRoot: root,
            providerId: "test",
            engineId: "mutagen",
            mountPlanDigest: "digest",
            phase: "apply-intent",
            sessions: [],
            targets: [],
          });
        }).pipe(
          Effect.provide(StateStoreService.layer.pipe(Layer.provide(Layer.succeed(PathsService, paths)))),
        ),
      );
      // When the resilient entry point collects the full opt-in report.
      const report = await withCwd(root, () =>
        Effect.runPromise(
          resilientDoctorReport({ app: true, deprecations: true, fix, platform: "darwin", env: {} }).pipe(
            Effect.provide(factory),
            Effect.provideService(GlobalConfigSources, {
              env: {},
              sources: { user: false, env: false },
              rootOverrides: roots,
            }),
          ),
        ),
      );

      // Then uninspected sections are explicit skips, not stub warnings or healthy empty results.
      expect(report.globalConfig?.status).toBe("pass");
      expect(report.self?.checks).toEqual([
        expect.objectContaining({ section: "provider-bootstrap", status: "fail", reason: "failure" }),
      ]);
      expect(report.skipped?.map((entry) => entry.section)).toEqual([
        "provider",
        "subsystems",
        "certificate-authority",
        "missing-app-roots",
        "orphaned-volume-snapshots",
        "app-config",
        "deprecations",
      ]);
      expect(
        report.skipped?.every(
          (entry) => entry.status === "skipped" && entry.reason.includes("provider-bootstrap"),
        ),
      ).toBe(true);
      expect(report.provider.checks).toEqual([]);
      expect(report.subsystems.checks.map((check) => check.name)).toContain("filesystem-watch");
      expect(report.subsystems.checks.map((check) => check.name)).toContain("network-trust");
      expect(report.subsystems.checks.map((check) => check.name)).toContain("legacy-snapshot-catalogs");
      expect(
        report.subsystems.checks.find((check) => check.name === "legacy-snapshot-catalogs")?.context.count,
      ).toBe("1");
      expect(
        report.subsystems.checks.find((check) => check.name === "accelerated-start")?.context.attemptId,
      ).toBe("host-attempt");
      for (const name of ["router", "ssh", "certs", "healthcheck", "url-scanner", "host-proxy"]) {
        expect(report.subsystems.checks.some((check) => check.name === name)).toBe(false);
      }
      expect(report.globalApp.checks.length).toBeGreaterThan(0);
      expect(report.mcp.checks.length).toBeGreaterThan(0);
      expect(report.appVersionConstraints?.checks).toEqual([
        expect.objectContaining({ name: "app-version-constraint", status: "pass" }),
      ]);
      expect(report.appConfig).toBeUndefined();
      expect(report.deprecations).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("lando doctor --fix");

      const encoded = Schema.encodeSync(DoctorReportSchema)(report);
      expect(encoded.skipped).toEqual(report.skipped);
      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed(report), {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat: "json",
        command: "meta:doctor",
        resultSchema: metaDoctorSpec.resultSchema,
        io,
        setExitCode: () => undefined,
        render: renderDoctorReport,
        formatError: ({ error }) => String(error),
      });
      const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
        JSON.parse(io.stdoutLines()[0] ?? "{}"),
      );
      expect(envelope.result).toEqual(encoded);
      const text = renderDoctorReport(report);
      const summary = buildDoctorReportSummary(report);
      const ndjson = renderDoctorReportAsNdjson(report);
      const events = ndjson
        .trimEnd()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)))
        .flatMap((frame) => (frame._tag === "event" ? [frame.payload] : []));
      for (const entry of report.skipped ?? []) {
        expect(text).toContain(`${entry.section}: SKIPPED`);
        expect(summary.sections.find((section) => section.title === "skipped")?.rows).toContainEqual(
          expect.objectContaining({ label: entry.section, value: "SKIPPED" }),
        );
        expect(events).toContainEqual(expect.objectContaining(entry));
      }
      expect(text).toContain("section: provider-bootstrap");
      expect(ndjson).toContain('"section":"provider-bootstrap"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
