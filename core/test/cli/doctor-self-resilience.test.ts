import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Duration, Effect, Exit, Fiber, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";

import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap.ts";
import {
  type DoctorReport,
  DoctorReportSchema,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../src/cli/commands/doctor-report.ts";
import { isolateDoctorSection } from "../../src/cli/commands/doctor-self.ts";
import { metaDoctorSpec } from "../../src/cli/oclif/commands/meta/doctor.ts";

const SHORT_BUDGET_ENV = { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } as const;

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

describe("doctor safe mode", () => {
  test("reports a bootstrap failure as a self check and still returns a report", async () => {
    // Given a config file the YAML reader cannot parse, which fails the
    // provider runtime build itself
    const home = await mkdtemp(join(tmpdir(), "lando-doctor-safe-"));
    await mkdir(join(home, ".config", "lando"), { recursive: true });
    await writeFile(join(home, ".config", "lando", "config.yml"), "this: [is: not\n", "utf8");
    const priorHome = process.env.HOME;
    const priorXdgConfig = process.env.XDG_CONFIG_HOME;

    try {
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");

      // When
      const report = await Effect.runPromise(resilientDoctorReport({ env: SHORT_BUDGET_ENV }));

      // Then the provider section degrades but the report is intact
      const bootstrapSelf = (report.self?.checks ?? []).find(
        (check) => check.section === "provider-bootstrap",
      );
      expect(bootstrapSelf).toMatchObject({ status: "fail", severity: "error" });
      expect(bootstrapSelf?.solutions.some((solution) => solution.command === "lando config view")).toBe(
        true,
      );
      expect(report.provider.checks).toEqual([]);
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    } finally {
      restoreEnv("HOME", priorHome);
      restoreEnv("XDG_CONFIG_HOME", priorXdgConfig);
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("doctor degradation is visible to automation", () => {
  const reportWithSelf = (): DoctorReport => ({
    provider: { checks: [] },
    subsystems: { checks: [] },
    globalApp: { checks: [] },
    mcp: { checks: [] },
    self: {
      checks: [
        {
          name: "doctor-self",
          section: "provider-bootstrap",
          status: "fail",
          severity: "error",
          reason: "failure",
          context: { section: "provider-bootstrap", reason: "failure", message: "boom" },
          solutions: [{ kind: "manual", description: "fix it" }],
        },
      ],
    },
  });

  test("ndjson emits self checks and counts them as failures", () => {
    // When
    const ndjson = renderDoctorReportAsNdjson(reportWithSelf());

    // Then the degradation is visible as an event and in the summary
    expect(ndjson).toContain("provider-bootstrap");
    const summary = JSON.parse(ndjson.trimEnd().split("\n").at(-1) ?? "{}");
    expect(summary.envelope.result.failed).toBe(1);
    expect(summary.envelope.result.checks).toBe(1);
  });

  test("a degraded report exits non-zero so scripts cannot read it as healthy", () => {
    // When / Then
    expect(metaDoctorSpec.successExitCode?.(reportWithSelf(), {})).toBe(1);
  });

  test("a healthy report keeps the default exit code", () => {
    // Given a report with no self section
    const healthy: DoctorReport = {
      provider: { checks: [] },
      subsystems: { checks: [] },
      globalApp: { checks: [] },
      mcp: { checks: [] },
    };

    // When / Then
    expect(metaDoctorSpec.successExitCode?.(healthy, {})).toBeUndefined();
  });

  test("text output surfaces the self section", () => {
    // When
    const text = renderDoctorReport(reportWithSelf());

    // Then
    expect(text).toContain("doctor-self: fail");
    expect(text).toContain("section: provider-bootstrap");
  });
});

describe("isolateDoctorSection", () => {
  test("captures a typed failure as a self check carrying the error tag", async () => {
    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({
        section: "unit",
        effect: Effect.fail(new ConfigError({ message: "bad config" })),
        fallback: "fallback",
      }),
    );

    // Then
    expect(outcome.value).toBe("fallback");
    expect(outcome.self).toMatchObject({ reason: "failure", section: "unit", status: "fail" });
    expect(outcome.self?.context.failure).toBe("ConfigError");
  });

  test("captures an untyped defect", async () => {
    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({ section: "unit", effect: Effect.die(new Error("boom")), fallback: 0 }),
    );

    // Then
    expect(outcome.value).toBe(0);
    expect(outcome.self).toMatchObject({ reason: "defect" });
    expect(outcome.self?.context.message).toBe("boom");
  });

  test("abandons a section that overruns its deadline", async () => {
    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({ section: "unit", effect: Effect.never, fallback: "gave-up", budgetMs: 1_000 }),
    );

    // Then
    expect(outcome.value).toBe("gave-up");
    expect(outcome.self).toMatchObject({ reason: "timeout" });
    expect(outcome.self?.context.budgetMs).toBe("1000");
  });

  test("records a self-interrupting section as a defect instead of aborting the run", async () => {
    // Given a section that interrupts itself, which must not masquerade as Ctrl-C
    const program = isolateDoctorSection({
      section: "unit",
      effect: Effect.interrupt,
      fallback: "fallback",
    });

    // When
    const outcome = await Effect.runPromise(program);

    // Then
    expect(outcome.value).toBe("fallback");
    expect(outcome.self).toMatchObject({ reason: "defect", section: "unit", status: "fail" });
  });

  test("still cancels the whole run when the caller is interrupted", async () => {
    // Given an isolated section that never settles, forked so we can interrupt its caller
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        isolateDoctorSection({
          section: "unit",
          effect: Effect.never,
          fallback: "unused",
          budgetMs: 120_000,
        }),
      );
      yield* Effect.sleep(Duration.millis(50));

      // When the caller is interrupted
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    });
    const exit = await Effect.runPromise(program);

    // Then cancellation propagates rather than becoming a self check
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterrupted(exit.cause)).toBe(true);
    }
  });

  test("applies the caller's redactor to the failure message", async () => {
    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({
        section: "unit",
        effect: Effect.die(new Error("token=abc123")),
        fallback: undefined,
        redact: (value) => value.replace("abc123", "[redacted]"),
      }),
    );

    // Then
    expect(outcome.self?.context.message).toBe("token=[redacted]");
  });
});
