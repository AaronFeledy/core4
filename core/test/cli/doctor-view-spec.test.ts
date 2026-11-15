import { expect, test } from "bun:test";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { MalformedCliFlagValueError } from "@lando/sdk/errors";
import { Effect, Layer } from "effect";
import { inputDoctorOptions, metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report-model";
import { selectDoctorView } from "../../src/cli/commands/doctor-view";
import { validateCliFlagValues } from "../../src/cli/flag-value-validation";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { compiledCommandOptionsFromSpec } from "../../src/cli/run-built-in-command";

test("the command applies its view after collection and retains hidden global-config failure completion", async () => {
  const input = { flags: { section: "mcp", status: "pass", limit: 1 } };
  const report = await Effect.runPromise(
    metaDoctorSpec.run(input).pipe(
      Effect.provideService(
        RuntimeLayerFactory,
        RuntimeLayerFactory.of({
          make: <Services>(): Layer.Layer<Services> =>
            Layer.effectContext(Effect.die("unused provider runtime")),
        }),
      ),
      Effect.provideService(GlobalConfigSources, {
        env: {},
        sources: { user: false, env: false },
        host: { router: { httpPort: 99999 } },
      }),
    ),
  );
  expect(report.checks.map((check) => check.id)).toEqual(["mcp/mcp"]);
  expect(report.page).toEqual({ limit: 1, matched: 1 });
  expect(report.summary).toEqual({ checks: 2, passed: 1, warned: 0, failed: 1, selfFailed: 0 });
  expect(metaDoctorSpec.completion?.(report, input)).toEqual({ ok: true, exitCode: 1 });
});

test.each(["0", "-1", "1001", "1.5", "NaN"])("rejects doctor limit %s", (limit) => {
  expect(() => inputDoctorOptions({ flags: { limit } })).toThrow(MalformedCliFlagValueError);
});

test.each([1, 1000])("accepts doctor limit boundary %i", (limit) => {
  expect(validateCliFlagValues(["--limit", String(limit)], metaDoctorSpec.flags ?? {})).toBeUndefined();
  expect(inputDoctorOptions({ flags: { limit } }).limit).toBe(limit);
});

test("validates declared status options, repeated statuses, integer syntax and cursor dependencies", () => {
  expect(validateCliFlagValues(["--status", "unknown"], metaDoctorSpec.flags ?? {})).toMatchObject({
    issue: "invalid_option",
    flag: "status",
  });
  expect(validateCliFlagValues(["--limit", "1.5"], metaDoctorSpec.flags ?? {})).toMatchObject({
    issue: "invalid_integer",
    flag: "limit",
  });
  expect(validateCliFlagValues(["--limit", "0"], metaDoctorSpec.flags ?? {})).toMatchObject({
    issue: "invalid_integer",
    flag: "limit",
  });
  expect(
    validateCliFlagValues(["--status", "fail", "--status", "warn"], metaDoctorSpec.flags ?? {}),
  ).toBeUndefined();
  expect(() => inputDoctorOptions({ flags: { status: "unknown" } })).toThrow(MalformedCliFlagValueError);
  expect(() => inputDoctorOptions({ flags: { after: "provider/removed" } })).toThrow(
    MalformedCliFlagValueError,
  );
  expect(() => inputDoctorOptions({ flags: { limit: 1, after: "unknown/check" } })).toThrow(
    MalformedCliFlagValueError,
  );
  expect(
    inputDoctorOptions({ flags: { limit: 1, after: "provider/removed", status: ["fail", "warn"] } }),
  ).toMatchObject({ after: "provider/removed", statuses: ["fail", "warn"] });
});

test.each(["text", "json", "yaml", "ndjson"] as const)(
  "hidden failures retain completion and redaction in %s",
  async (format) => {
    const secret = "track-p-secret-value";
    const report = makeDoctorReport({
      checks: [
        {
          section: "provider",
          name: "doctor-self",
          status: "fail",
          severity: "error",
          context: {},
          solutions: [],
        },
        {
          section: "mcp",
          name: "visible",
          subject: secret,
          status: "pass",
          severity: "info",
          context: { detail: secret },
          solutions: [],
        },
      ],
      skipped: [],
    });
    const input = { flags: { format, status: "pass", limit: 1 } };
    const view = selectDoctorView(report, inputDoctorOptions(input));
    expect(metaDoctorSpec.completion?.(view, input)).toEqual({ ok: false, exitCode: 1 });
    expect(view.summary).toEqual({ checks: 2, failed: 1, passed: 1, warned: 0, selfFailed: 1 });
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    await runWithRendererHandling(
      Effect.gen(function* () {
        yield* (yield* RedactionService).registerValues([secret]);
        return view;
      }),
      {
        ...compiledCommandOptionsFromSpec(metaDoctorSpec, input),
        runtime: Layer.succeed(RedactionService, RedactionService.of(makeRedactionService())),
        rendererMode: "plain",
        resultFormat: format,
        command: metaDoctorSpec.id,
        resultSchema: metaDoctorSpec.resultSchema,
        io,
        render: (value, ctx) => metaDoctorSpec.render?.(value, input, ctx),
        setExitCode: (code) => codes.push(code),
        formatError: () => "unexpected rendering failure",
      },
    );
    expect(codes).toEqual([1]);
    expect(io.stdout()).not.toContain(secret);
    expect(io.stdout()).toContain("[redacted]");
    if (format === "ndjson") {
      expect(JSON.parse(io.stdout().trimEnd().split("\n").at(-1) ?? "{}")).toMatchObject({
        envelope: { ok: false, result: { page: { limit: 1, matched: 1 }, summary: { failed: 1 } } },
      });
    }
  },
);

test("hiding ordinary failures preserves a successful diagnostic outcome with exit 1", () => {
  const report = makeDoctorReport({
    checks: [
      { section: "provider", name: "broken", status: "fail", severity: "error", context: {}, solutions: [] },
    ],
    skipped: [],
  });
  const view = selectDoctorView(report, { statuses: ["pass"], limit: 1 });
  expect(view.checks).toEqual([]);
  expect(metaDoctorSpec.completion?.(view, {})).toEqual({ ok: true, exitCode: 1 });
});

test("the text continuation reruns the same sections, opt-ins, and statuses", () => {
  const finding = (subject: string) =>
    ({
      section: "missing-app-roots",
      name: "missing-app-root",
      subject,
      status: "warn",
      severity: "warn",
      context: {},
      solutions: [],
    }) as const;
  const input = {
    flags: { section: ["missing-app-roots"], deprecations: true, status: ["warn"], limit: 1 },
  };
  const report = makeDoctorReport({ checks: [finding("/a"), finding("/b")], skipped: [] });
  const text = metaDoctorSpec.render?.(selectDoctorView(report, inputDoctorOptions(input)), input, undefined);
  expect(text).toContain(
    "lando doctor --format=json --section missing-app-roots --deprecations --status warn --limit 1 --after missing-app-roots/missing-app-root//a",
  );
});
