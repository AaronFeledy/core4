import { describe, expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect, Layer } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor";
import type { DoctorCheck, DoctorFinding, DoctorReport } from "../../src/cli/commands/doctor-contract";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-contract";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson";
import { buildDoctorReportSummary, renderDoctorReport } from "../../src/cli/commands/doctor-render-text";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report";
import { type RenderContext, runWithRendererHandling } from "../../src/cli/renderer-boundary";

const tty: RenderContext = { mode: "lando", format: "text", isTTY: true, columns: 80, noColor: true };
const check = (overrides: Partial<DoctorCheck> = {}): DoctorCheck => ({
  section: "provider",
  name: "selected-provider",
  status: "pass",
  severity: "info",
  context: {},
  solutions: [],
  ...overrides,
});
const report = (
  checks: ReadonlyArray<DoctorCheck>,
  extras: { readonly skipped?: DoctorReport["skipped"] } = {},
): DoctorReport =>
  makeDoctorReport({
    version: "4.2.0",
    provider: {
      id: "lando",
      kind: "managed",
      selection: {
        providerId: "lando",
        source: "config",
        inputs: { config: "lando", capabilityDefault: "lando" },
      },
      name: "Lando",
      version: "4.2.0",
      runtimeStatus: "ready",
      runtime: { running: true, version: "6.0.0" },
      capabilities: { buildSecrets: true },
    },
    checks,
    skipped: extras.skipped ?? [],
  });

const findingIn = (section: DoctorCheck["section"], finding: DoctorFinding): DoctorCheck => ({
  section,
  ...finding,
});

const leftovers = report([
  check(),
  ...Array.from({ length: 365 }, (_, index) =>
    findingIn("accelerated-starts", {
      name: "accelerated-start",
      status: "warn",
      severity: "warn",
      context: {
        appId: `app-${index}`,
        appRoot: `/apps/accelerated-${index}`,
        journalPath: `/journals/${index}`,
        volumes: Array.from({ length: 40 }, (_, n) => `volume-${n}`).join(", "),
      },
      solutions: [
        {
          kind: "manual",
          description: "Finish the interrupted start. Keep the only copy of your files.",
          command: `lando start --root /apps/accelerated-${index}`,
        },
      ],
    }),
  ),
  ...Array.from({ length: 24 }, (_, index) =>
    findingIn("missing-app-roots", {
      name: "missing-app-root",
      status: "warn",
      severity: "warn",
      context: { root: `/apps/missing-${index}` },
      solutions: [
        {
          kind: "manual",
          description: "Remove leftovers. Dropping --volumes keeps data.",
          command: "lando apps:gc --prune --volumes",
        },
      ],
    }),
  ),
]);

describe("bounded doctor text", () => {
  test.each([undefined, { ...tty, columns: 40 }, tty, { ...tty, columns: 120 }])(
    "bounds hundreds of records on text surface %j while --all preserves each one",
    (context) => {
      const bounded = renderDoctorReport(leftovers, context);
      const full = renderDoctorReport(leftovers, context, { all: true });
      const boundedLines = bounded.split("\n").length;
      expect(boundedLines).toBeLessThan(70);
      expect(bounded).toContain("365 checks");
      expect(bounded).toContain("24 checks");
      expect(bounded).toContain("+362 more");
      expect(bounded).toContain("365 remediation variants");
      expect(bounded).not.toContain("accelerated-364");
      expect(bounded).not.toContain("buildSecrets");
      const all = buildDoctorReportSummary(leftovers, { all: true });
      expect(all.sections.find((section) => section.title === "provider")?.rows).toHaveLength(1);
      for (let index = 0; index < 365; index++) expect(full).toContain(`/apps/accelerated-${index}`);
      for (let index = 0; index < 24; index++) expect(full).toContain(`/apps/missing-${index}`);
      expect(full).toContain("volume-39");
      expect(full).toContain("buildSecrets");
      expect(all.nextSteps).toHaveLength(366);
      expect(buildDoctorReportSummary(leftovers).nextSteps).toHaveLength(2);
    },
  );

  test.each(["json", "yaml"] as const)(
    "keeps every record in %s and NDJSON without --all",
    async (format) => {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed(leftovers), {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat: format,
        command: "meta:doctor",
        resultSchema: DoctorReportSchema,
        io,
        render: renderDoctorReport,
        formatError: ({ error }) => String(error),
      });
      const output = io.stdoutLines().join("\n");
      const json = format === "json" ? JSON.parse(output) : Bun.YAML.parse(output);
      expect(json.result.checks).toEqual(leftovers.checks);
      const frames = renderDoctorReportAsNdjson(leftovers)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(frames.filter((frame) => frame._tag === "event" && frame.event === "doctor.check")).toHaveLength(
        390,
      );
    },
  );

  test("groups nonadjacent records by contributor, name and status without attributing a variant remedy to all", () => {
    const finding = (pluginId: string, root: string, description: string): DoctorCheck =>
      check({
        name: "cleanup",
        status: "warn",
        severity: "warn",
        context: { pluginId, root },
        solutions: [
          { kind: "manual", description, command: "lando cleanup" },
          { kind: "manual", description: "Other", command: `lando remove ${root}` },
        ],
      });
    const summary = buildDoctorReportSummary(
      report([
        finding("one", "/first", "First"),
        finding("two", "/other", "Foreign"),
        finding("one", "/second", "Second"),
        check({ name: "cleanup", status: "fail", severity: "error", context: { pluginId: "one" } }),
      ]),
    );
    const rows = summary.sections.find((section) => section.title === "provider")?.rows;
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.value).toBe("warn (2 checks)");
    expect(rows?.[0]?.remedy).toBe("2 remediation variants (lando doctor --all) Run `lando cleanup`.");
    expect(rows?.[0]?.fields).toContainEqual({ label: "entries", value: "root: /first; root: /second" });
    expect(rows?.[1]?.remedy).toContain("Foreign");
  });

  test("bounds only declared list keys and context values, preserving complete solutions", () => {
    const command = `lando repair ${"x".repeat(400)}`;
    const description = `Keep your data. ${"details, ".repeat(80)}`;
    const value = report([
      check({
        status: "warn",
        severity: "warn",
        context: {
          files: "one, two, three, four, five",
          targets: "a-sync, b-sync, c-sync, d-sync",
          error: "one, two, three, four, five",
          evidence: "x".repeat(500),
        },
        solutions: [{ kind: "manual", description, command }],
      }),
    ]);
    const text = renderDoctorReport(value);
    expect(text).toContain("files: one, two, three (+2 more)");
    expect(text).toContain("targets: a-sync, b-sync, c-sync (+1 more)");
    expect(text).toContain("error: one, two, three, four, five");
    expect(text).not.toContain("x".repeat(500));
    expect(text).toContain(description);
    expect(text).toContain(command);
    const full = renderDoctorReport(value, undefined, { all: true });
    expect(full).toContain("files: one, two, three, four, five");
    expect(full).toContain(`evidence: ${"x".repeat(500)}`);
  });

  test("plain header prints provider identity and selection once and flag plumbing enables full output", () => {
    const text = metaDoctorSpec.render?.(leftovers, { flags: {} });
    const full = metaDoctorSpec.render?.(leftovers, { flags: { all: true } });
    expect(text).toContain("version: 4.2.0");
    for (const key of ["providerName", "providerVersion", "providerKind", "runtimeStatus", "selectionSource"])
      expect(text?.split(`${key}:`)).toHaveLength(2);
    expect(full).toContain("selected-provider: pass");
    expect(full).toContain("/apps/accelerated-364");
    expect(text).not.toContain("/apps/accelerated-364");
  });

  test.each([undefined, tty])(
    "always shows skipped sections, each self failure, and deprecations on surface %j",
    (context) => {
      const value = report(
        [
          check(),
          findingIn("global-config", {
            name: "global-config",
            status: "fail",
            severity: "error",
            context: { message: "bad config" },
            solutions: [],
          }),
          findingIn("deprecations", {
            name: "deprecation",
            status: "fail",
            severity: "error",
            context: { kind: "service-type", id: "legacy", since: "4.2.0" },
            solutions: [{ kind: "manual", description: "Replace legacy" }],
          }),
          ...["first", "second", "third", "fourth"].map((message) =>
            findingIn("provider", {
              name: "doctor-self",
              status: "fail",
              severity: "error",
              context: { reason: "failure", message },
              solutions: [],
            }),
          ),
        ],
        { skipped: [{ section: "app-listeners", reason: "Runtime idle" }] },
      );
      const text = renderDoctorReport(value, context);
      expect(text).toContain("global-config");
      expect(text).toContain("fail");
      expect(text).toContain("SKIPPED");
      expect(text).toContain("Runtime idle");
      expect(text).toContain("legacy");
      for (const message of ["first", "second", "third", "fourth"]) expect(text).toContain(message);
      expect(text.split("doctor-self")).toHaveLength(5);
    },
  );
});
