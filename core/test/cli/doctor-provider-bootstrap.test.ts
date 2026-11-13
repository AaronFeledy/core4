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
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns";
import {
  DoctorReportSchema,
  buildDoctorReportSummary,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../src/cli/commands/doctor-report";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { withCwd } from "../_support/temp-cwd";

describe("doctor provider-bootstrap failure", () => {
  test.each(["mcp", "network-trust"])(
    "does not construct a provider runtime for --section %s",
    async (section) => {
      let builds = 0;
      const factory = Layer.succeed(
        RuntimeLayerFactory,
        RuntimeLayerFactory.of({
          make: <Services>(): Layer.Layer<Services, ConfigError> => {
            builds += 1;
            return Layer.effectContext(Effect.die("provider runtime must remain lazy"));
          },
        }),
      );
      const report = await Effect.runPromise(
        resilientDoctorReport({ sections: [section], env: {} }).pipe(
          Effect.provide(factory),
          Effect.provideService(GlobalConfigSources, { env: {}, sources: { user: false, env: false } }),
          Effect.provideService(
            HostDnsResolver,
            HostDnsResolver.of({ lookup: () => Effect.succeed(["127.0.0.1"]) }),
          ),
        ),
      );
      expect(builds).toBe(0);
      expect(report.checks.map((check) => check.section)).toEqual(["global-config", section]);
      expect(report.checks.some((check) => check.name === "doctor-self")).toBe(false);
    },
  );

  test("--section subsystems builds the provider runtime and degrades when it cannot", async () => {
    let builds = 0;
    const factory = Layer.succeed(
      RuntimeLayerFactory,
      RuntimeLayerFactory.of({
        make: <Services>(): Layer.Layer<Services, ConfigError> => {
          builds += 1;
          return Layer.effectContext(Effect.die("provider runtime unavailable"));
        },
      }),
    );
    const report = await Effect.runPromise(
      resilientDoctorReport({ sections: ["subsystems"], env: {} }).pipe(
        Effect.provide(factory),
        Effect.provideService(GlobalConfigSources, { env: {}, sources: { user: false, env: false } }),
        Effect.provideService(
          HostDnsResolver,
          HostDnsResolver.of({ lookup: () => Effect.succeed(["127.0.0.1"]) }),
        ),
      ),
    );
    expect(builds).toBe(1);
    expect(report.checks.find((check) => check.name === "doctor-self")?.context.probe).toBe(
      "provider-bootstrap",
    );
    expect(report.checks.some((check) => check.section === "subsystems" && check.name === "host-dns")).toBe(
      true,
    );
    expect(
      report.skipped.filter(
        (skip) => skip.section === "subsystems" && skip.reason.includes("provider runtime"),
      ),
    ).toEqual([expect.objectContaining({ check: "router" }), expect.objectContaining({ check: "ssh" })]);
  });

  test("invalid global config still runs the requested app version check", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-config-independent-"));
    try {
      await writeFile(join(root, ".lando.yml"), "name: independent-app\nlando: '>=99'\n");
      const factory = Layer.succeed(
        RuntimeLayerFactory,
        RuntimeLayerFactory.of({
          make: <Services>(): Layer.Layer<Services> => Layer.effectContext(Effect.die("unused")),
        }),
      );
      const report = await withCwd(root, () =>
        Effect.runPromise(
          resilientDoctorReport({ app: true, env: {}, platform: "darwin" }).pipe(
            Effect.provide(factory),
            Effect.provideService(GlobalConfigSources, {
              env: {},
              sources: { user: false, env: false },
              host: { router: { httpPort: 99999 } },
            }),
          ),
        ),
      );
      expect(report.checks.find((check) => check.section === "global-config")?.status).toBe("fail");
      expect(report.checks.find((check) => check.section === "app-version-constraints")?.status).toBe("fail");
      expect(report.checks.find((check) => check.section === "mcp")?.status).toBe("pass");
      expect(
        report.skipped.some((skip) => skip.section === "app-version-constraints" || skip.section === "mcp"),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
          Layer.effectContext(
            Effect.fail(
              new ConfigError({
                message: "Injected runtime build failure",
                remediation: "Injected failure for doctor bootstrap fixture.",
              }),
            ),
          ),
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
            Effect.provideService(
              HostDnsResolver,
              HostDnsResolver.of({ lookup: () => Effect.succeed(["127.0.0.1"]) }),
            ),
            Effect.provideService(GlobalConfigSources, {
              env: {},
              sources: { user: false, env: false },
              rootOverrides: roots,
            }),
          ),
        ),
      );

      // Then uninspected sections are explicit skips, not stub warnings or healthy empty results.
      expect(report.checks.find((check) => check.section === "global-config")?.status).toBe("pass");
      expect(report.checks.find((check) => check.name === "doctor-self")).toMatchObject({
        section: "provider",
        status: "fail",
        context: { probe: "provider-bootstrap", reason: "failure" },
      });
      expect(report.skipped.map((entry) => entry.section)).toEqual(
        expect.arrayContaining([
          "provider",
          "subsystems",
          "certificate-authority",
          "missing-app-roots",
          "orphaned-volume-snapshots",
          "app-config",
          "app-listeners",
          "deprecations",
        ]),
      );
      expect(
        report.skipped
          .filter((entry) => entry.section !== "subsystems")
          .map((entry) => entry.check)
          .filter((check) => check !== undefined),
      ).toEqual([]);
      expect(
        report.skipped.filter((entry) => entry.section === "subsystems").map((entry) => entry.check),
      ).toEqual(expect.arrayContaining(["router", "ssh", "healthcheck", "scanner"]));
      expect(report.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
      expect(
        report.checks
          .filter((check) => check.section === "provider")
          .every((check) => check.name === "doctor-self"),
      ).toBe(true);
      expect(
        report.checks.filter((check) => check.section === "filesystem-watch").map((check) => check.name),
      ).toContain("filesystem-watch");
      expect(
        report.checks.filter((check) => check.section === "network-trust").map((check) => check.name),
      ).toContain("network-trust");
      expect(
        report.checks
          .filter((check) => check.section === "legacy-snapshot-catalogs")
          .map((check) => check.name),
      ).toContain("legacy-snapshot-catalogs");
      expect(
        report.checks.find(
          (check) =>
            check.section === "legacy-snapshot-catalogs" && check.name === "legacy-snapshot-catalogs",
        )?.context.count,
      ).toBe("1");
      expect(
        report.checks.find(
          (check) => check.section === "accelerated-starts" && check.name === "accelerated-start",
        )?.context.attemptId,
      ).toBe("host-attempt");
      expect(
        report.checks.find((check) => check.section === "subsystems" && check.name === "host-dns"),
      ).toMatchObject({
        status: "pass",
        context: { dnsResolved: "true", dnsAddresses: "127.0.0.1" },
      });
      for (const name of ["router", "ssh", "certs", "healthcheck", "url-scanner"]) {
        expect(report.checks.some((check) => check.section === "subsystems" && check.name === name)).toBe(
          false,
        );
      }
      expect(report.checks.filter((check) => check.section === "global-app").length).toBeGreaterThan(0);
      expect(report.checks.filter((check) => check.section === "mcp").length).toBeGreaterThan(0);
      expect(report.checks.filter((check) => check.section === "app-version-constraints")).toEqual([
        expect.objectContaining({ name: "app-version-constraint", status: "pass" }),
      ]);
      expect(report.checks.some((check) => check.section === "app-config")).toBe(false);
      expect(report.checks.some((check) => check.section === "deprecations")).toBe(false);
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
      for (const entry of report.skipped) {
        expect(text).toContain(`${entry.check ?? entry.section}: SKIPPED`);
        expect(summary.sections.find((section) => section.title === "skipped")?.rows).toContainEqual(
          expect.objectContaining({ label: entry.check ?? entry.section, value: "SKIPPED" }),
        );
        expect(events).toContainEqual(expect.objectContaining(entry));
      }
      expect(text).toContain("probe: provider-bootstrap");
      expect(ndjson).toContain('"probe":"provider-bootstrap"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
