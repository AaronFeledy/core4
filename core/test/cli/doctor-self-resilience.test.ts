import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClock } from "effect/testing";

import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect";

import { makeTestSecretStore } from "@lando/core/testing";
import { ConfigError } from "@lando/sdk/errors";

import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { RedactionService } from "@lando/redaction/service";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor.ts";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap.ts";
import {
  type DoctorReport,
  DoctorReportSchema,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../src/cli/commands/doctor-report.ts";
import { isolateDoctorSection } from "../../src/cli/commands/doctor-self.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { withEnvVar } from "../_support/temp-cwd";

const SHORT_BUDGET_ENV = { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } as const;
const runtimeLayerFactoryLive = Layer.succeed(
  RuntimeLayerFactory,
  RuntimeLayerFactory.of({ make: makeLandoRuntime }),
);

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

describe("doctor safe mode", () => {
  test("preserves environment repair advice when provider bootstrap reads a valid file", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-doctor-env-"));
    await writeFile(join(root, "config.yml"), "router:\n  httpPort: 8080\n");
    try {
      await withEnvVar("LANDO_USER_CONF_ROOT", root, () =>
        withEnvVar("LANDO_USER_DATA_ROOT", join(root, "data"), () =>
          withEnvVar("LANDO_USER_CACHE_ROOT", join(root, "cache"), () =>
            withEnvVar("LANDO_ROUTER_HTTP_PORT", "99999", async () => {
              const report = await Effect.runPromise(
                resilientDoctorReport({ env: SHORT_BUDGET_ENV }).pipe(
                  Effect.provide(runtimeLayerFactoryLive),
                ),
              );
              const bootstrap = report.self?.checks.find((check) => check.section === "global-config");
              expect(bootstrap?.context.failure).toBe("ConfigError");
              expect(
                bootstrap?.solutions.some((solution) =>
                  solution.description.includes("Unset or fix the environment override for router.httpPort"),
                ),
              ).toBe(true);
              expect(report.globalConfig?.error?.issues?.[0]?.source?.layer).toBe("env");
              expect(bootstrap?.context.message).not.toContain("Invalid config file");
              expect(
                bootstrap?.solutions.some((solution) => solution.description.includes("github.com")),
              ).toBe(false);
            }),
          ),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("keeps AbortSignal cancellation on the resilient path", async () => {
    // Given an already-cancelled doctor run
    const controller = new AbortController();
    controller.abort();

    // When
    const exit = await Effect.runPromiseExit(
      resilientDoctorReport({ signal: controller.signal }).pipe(Effect.provide(runtimeLayerFactoryLive)),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  test.each([
    { content: "this: [is: not\n", detail: "Unsupported YAML" },
    { content: "router:\n  httpPort: 99999\n", detail: "router.httpPort:" },
  ])("reports a bootstrap failure for $detail and still returns a report", async ({ content, detail }) => {
    // Given invalid global configuration that fails the provider runtime build.
    const home = await mkdtemp(join(tmpdir(), "lando-doctor-safe-"));
    await mkdir(join(home, ".config", "lando"), { recursive: true });
    await writeFile(join(home, ".config", "lando", "config.yml"), content, "utf8");
    const priorHome = process.env.HOME;
    const priorXdgConfig = process.env.XDG_CONFIG_HOME;
    // The test preload pins the conf root, which outranks HOME/XDG; point it at the broken config.
    const priorConfRoot = process.env.LANDO_USER_CONF_ROOT;

    try {
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");
      process.env.LANDO_USER_CONF_ROOT = join(home, ".config", "lando");

      // When
      const report = await Effect.runPromise(
        resilientDoctorReport({ env: SHORT_BUDGET_ENV }).pipe(Effect.provide(runtimeLayerFactoryLive)),
      );

      // Then the provider section degrades but the report is intact
      const bootstrapSelf = (report.self?.checks ?? []).find((check) => check.section === "global-config");
      expect(bootstrapSelf).toMatchObject({ status: "fail", severity: "error" });
      expect(bootstrapSelf?.context.failure).toBe("ConfigError");
      expect(bootstrapSelf?.context.message).toContain(detail);
      expect(bootstrapSelf?.solutions.some((solution) => solution.command === "lando config validate")).toBe(
        true,
      );
      expect(report.provider.checks).toEqual([]);
      expect(report.subsystems.checks.some((check) => check.name === "filesystem-watch")).toBe(true);
      expect(report.globalConfig?.status).toBe("fail");
      expect(report.globalConfig?.error?._tag).toBe("ConfigError");
      expect(report.skipped?.map((entry) => entry.section)).toEqual([
        "provider",
        "subsystems",
        "network-trust",
        "certificate-authority",
        "global-app",
        "mcp",
      ]);
      expect(
        report.skipped?.every(
          (entry) => entry.status === "skipped" && entry.reason.includes("global-config"),
        ),
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain("--fix");
      expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    } finally {
      restoreEnv("HOME", priorHome);
      restoreEnv("XDG_CONFIG_HOME", priorXdgConfig);
      restoreEnv("LANDO_USER_CONF_ROOT", priorConfRoot);
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("doctor degradation is visible to automation", () => {
  const reportWithSelf = (): DoctorReport => ({
    version: "4.0.0-test",
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
    expect(metaDoctorSpec.completion?.(reportWithSelf(), {})).toEqual({ ok: false, exitCode: 1 });
  });

  test("a healthy report keeps the default exit code", () => {
    // Given a report with no self section
    const healthy: DoctorReport = {
      version: "4.0.0-test",
      provider: { checks: [] },
      subsystems: { checks: [] },
      globalApp: { checks: [] },
      mcp: { checks: [] },
    };

    // When / Then
    expect(metaDoctorSpec.completion?.(healthy, {})).toEqual({ ok: true, exitCode: 0 });
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
        effect: Effect.fail(
          new ConfigError({
            message: "bad config",
            remediation: "Injected failure for doctor self fixture.",
          }),
        ),
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
      const fiber = yield* Effect.forkChild(
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
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
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

  test("redacts a registered secret crossing the message boundary before applying the final cap", async () => {
    // Given a registered secret that straddles the 2,000-character boundary
    const secret = "registered-secret-ABCDEF-987654321";
    const failureMessage = `${"x".repeat(1_990)}${secret}${"y".repeat(2_000)}`;
    const secretStore = makeTestSecretStore({ secrets: { DOCTOR_TOKEN: secret } });
    const redactionLayer = RedactionService.layer.pipe(Layer.provide(secretStore.layer));

    // When
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RedactionService;
        const redactor = yield* service.forProfile("secrets");
        return yield* isolateDoctorSection({
          section: "unit",
          effect: Effect.die(new Error(failureMessage)),
          fallback: undefined,
          redact: redactor.redactString,
        });
      }).pipe(Effect.provide(redactionLayer)),
    );

    // Then no usable fragment survives and the reported message observes the final cap
    const message = outcome.self?.context.message ?? "";
    for (let offset = 0; offset <= secret.length - 8; offset += 1) {
      expect(message).not.toContain(secret.slice(offset, offset + 8));
    }
    expect(message.length).toBeLessThanOrEqual(2_000);
  });

  test("isolates a typed failure whose tag getter throws", async () => {
    // Given
    const failure = {
      get _tag(): string {
        throw new Error("tag getter exploded");
      },
    };

    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({ section: "unit", effect: Effect.fail(failure), fallback: "fallback" }),
    );

    // Then
    expect(outcome.value).toBe("fallback");
    expect(outcome.self).toMatchObject({ reason: "failure", status: "fail" });
    expect(typeof outcome.self?.context.message).toBe("string");
  });

  test("isolates a defect whose message getter throws", async () => {
    // Given
    const defect = {
      get message(): string {
        throw new Error("message getter exploded");
      },
    };

    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({
        section: "unit",
        effect: Effect.sync(() => {
          throw defect;
        }),
        fallback: "fallback",
      }),
    );

    // Then
    expect(outcome.value).toBe("fallback");
    expect(outcome.self).toMatchObject({ reason: "defect", status: "fail" });
    expect(typeof outcome.self?.context.message).toBe("string");
  });

  test("isolates a defect whose proxy traps throw", async () => {
    // Given
    const defect = new Proxy(
      {},
      {
        has: (target, property) => {
          if (property === "_tag") throw new Error("proxy trap exploded");
          return Reflect.has(target, property);
        },
      },
    );

    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({
        section: "unit",
        effect: Effect.sync(() => {
          throw defect;
        }),
        fallback: "fallback",
      }),
    );

    // Then
    expect(outcome.value).toBe("fallback");
    expect(outcome.self).toMatchObject({ reason: "defect", status: "fail" });
    expect(typeof outcome.self?.context.message).toBe("string");
  });

  test("isolates a defect whose string conversion throws", async () => {
    // Given
    const defect = {
      toString(): string {
        throw new Error("string conversion exploded");
      },
    };

    // When
    const outcome = await Effect.runPromise(
      isolateDoctorSection({ section: "unit", effect: Effect.die(defect), fallback: "fallback" }),
    );

    // Then
    expect(outcome.value).toBe("fallback");
    expect(outcome.self).toMatchObject({ reason: "defect", status: "fail" });
    expect(typeof outcome.self?.context.message).toBe("string");
  });

  test("waits for an interrupted section finalizer before returning its timeout", async () => {
    // Given
    let finalized = false;
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const section = Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
        Effect.sync(() => {
          finalized = true;
        }),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      const fiber = yield* Effect.forkChild(
        isolateDoctorSection({ section: "unit", effect: section, fallback: "fallback", budgetMs: 1_000 }),
      );
      yield* Deferred.await(started);

      // When
      yield* TestClock.adjust("1 second");
      return yield* Fiber.join(fiber);
    });
    const outcome = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));

    // Then
    expect(outcome.self?.reason).toBe("timeout");
    expect(finalized).toBe(true);
  });
});
