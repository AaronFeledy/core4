import { describe, expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { CommandResultEnvelope, GlobalConfig, ProviderId, StreamFrame } from "@lando/sdk/schema";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor";
import { doctor } from "../../src/cli/commands/doctor";
import type { DoctorReport } from "../../src/cli/commands/doctor-report";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { compiledCommandOptionsFromSpec } from "../../src/cli/run-built-in-command";

const emptyReport: DoctorReport = {
  version: "4.0.0-test",
  provider: { checks: [] },
  subsystems: { checks: [] },
  globalApp: { checks: [] },
  mcp: { checks: [] },
};

const providerReport = async (state: "running" | "idle" | "failure"): Promise<DoctorReport> => {
  const provider = {
    ...TestRuntimeProvider,
    getStatus:
      state === "failure"
        ? Effect.fail(
            new ProviderUnavailableError({
              providerId: TestRuntimeProvider.id,
              operation: "getStatus",
              message: "Runtime API cannot be reached.",
              remediation: "Restore runtime API access.",
            }),
          )
        : Effect.succeed({ state }),
  };
  const config = Schema.decodeUnknownSync(GlobalConfig)({ telemetry: { enabled: false } });
  const result = await Effect.runPromise(
    doctor({ flagProviderId: provider.id, env: {} }, []).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ConfigService, {
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
          Layer.succeed(PathsService, makeLandoPaths({ env: {} })),
          Layer.succeed(RuntimeProviderRegistry, {
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            appliedPlansFor: () => Effect.succeed([]),
            list: Effect.succeed([ProviderId.make(provider.id)]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
        ),
      ),
    ),
  );
  expect(result.selfChecks).toBeUndefined();
  return { ...emptyReport, provider: { checks: result.checks } };
};

describe("doctor command completion", () => {
  test("matches JSON completion when a doctor section fails", async () => {
    const report: DoctorReport = {
      ...emptyReport,
      self: {
        checks: [
          {
            name: "doctor-self",
            section: "provider-bootstrap",
            status: "fail",
            severity: "error",
            reason: "failure",
            context: {},
            solutions: [],
          },
        ],
      },
    };
    const envelopes = [];
    for (const format of ["json", "ndjson"] as const) {
      const input = { flags: { format } };
      const io = createBufferedRendererIO();
      const codes: number[] = [];
      await runWithRendererHandling(Effect.succeed(report), {
        ...compiledCommandOptionsFromSpec(metaDoctorSpec, input),
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: format,
        command: metaDoctorSpec.id,
        resultSchema: metaDoctorSpec.resultSchema,
        io,
        render: (value, ctx) => metaDoctorSpec.render?.(value, input, ctx),
        setExitCode: (code) => codes.push(code),
        formatError: () => "unexpected command failure",
      });
      const terminal = JSON.parse(io.stdout().trimEnd().split("\n").at(-1) ?? "{}");
      envelopes.push(format === "json" ? terminal : terminal.envelope);
      expect(codes).toEqual([1]);
    }
    expect(envelopes).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ _tag: "LandoCommandError" }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ _tag: "LandoCommandError" }) }),
    ]);
  });
  test.each(["text", "json", "yaml", "ndjson"] as const)(
    "returns a findings exit code for a real provider failure in %s",
    async (format) => {
      const report = await providerReport("failure");
      expect(report.provider.checks).toContainEqual(
        expect.objectContaining({ name: "selected-provider", status: "fail" }),
      );
      const io = createBufferedRendererIO();
      const codes: number[] = [];
      const input = { flags: { format } };

      await runWithRendererHandling(Effect.succeed(report), {
        ...compiledCommandOptionsFromSpec(metaDoctorSpec, input),
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: format,
        command: metaDoctorSpec.id,
        resultSchema: metaDoctorSpec.resultSchema,
        io,
        render: (value, ctx) => metaDoctorSpec.render?.(value, input, ctx),
        setExitCode: (code) => codes.push(code),
        formatError: () => "unexpected command failure",
      });

      expect(codes).toEqual([1]);
      if (format === "text") {
        expect(io.stdout()).toContain("selected-provider: fail");
      } else if (format === "ndjson") {
        expect(io.stdout().endsWith("}\n")).toBe(true);
        expect(io.stdout().endsWith("\n\n")).toBe(false);
        const frames = io
          .stdout()
          .trimEnd()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
        expect(frames.at(-1)).toMatchObject({
          _tag: "result",
          envelope: { ok: true, result: { failed: 1 } },
        });
      } else {
        const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
          format === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout()),
        );
        expect(envelope).toMatchObject({ ok: true, result: { provider: report.provider } });
      }
      expect(io.stderr()).not.toContain("unexpected command failure");
    },
  );

  test.each(["running", "idle"] as const)("keeps a %s provider successful", async (state) => {
    const report = await providerReport(state);
    expect(metaDoctorSpec.completion?.(report, {})).toEqual({ ok: true, exitCode: 0 });
  });

  test.each(["pass", "warn", "fail"] as const)("classifies %s subsystem findings", (status) => {
    const report: DoctorReport = {
      ...emptyReport,
      subsystems: {
        checks: [
          { name: "router", status, severity: "warn", recovery: "manual", context: {}, solutions: [] },
        ],
      },
    };
    expect(metaDoctorSpec.completion?.(report, {})).toEqual({
      ok: true,
      exitCode: status === "fail" ? 1 : 0,
    });
  });
});
