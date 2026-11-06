import { expect, test } from "bun:test";
import { ProcessExecError, ShellExecError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result } from "effect";
import { prepareHealthcheckAttempt } from "../../../src/subsystems/healthcheck/attempt.ts";
import { planWith } from "../../services/build-app-runner-test-support.ts";

const plan = planWith({ web: [] });
const service = ServiceName.make("web");
const probe = {
  kind: "command",
  executionTarget: "host",
  command: ["probe"],
  intervalSeconds: 0,
  timeoutSeconds: 1,
  retries: 0,
} as const;

test.each(["argv", "shell"] as const)("host %s nonzero is ordinary process evidence", async (mode) => {
  // Given
  const evidence = { exitCode: 23, stdout: "", stderr: "not-ready" };
  const input = {
    probe: { ...probe, command: mode === "argv" ? probe.command : "exit 23" },
    app: plan.id,
    service,
    plan,
    exec: TestRuntimeProvider.exec,
    runners: {
      process: { run: () => Effect.succeed(evidence) },
      shell: {
        run: () =>
          Effect.fail(
            new ShellExecError({
              command: "exit 23",
              message: "failed",
              exitCode: 23,
              stderr: evidence.stderr,
              remediation: "retry",
            }),
          ),
      },
    },
  };
  // When
  const result = await Effect.runPromise(
    prepareHealthcheckAttempt(input).pipe(Effect.flatMap((attempt) => attempt.run)),
  );
  // Then
  expect(result).toEqual(evidence);
});

test.each(["argv", "shell"] as const)(
  "host %s infrastructure failure is sanitized rather than a fake exit",
  async (mode) => {
    // Given
    const canary = "host-probe-infrastructure-private";
    const input = {
      probe: { ...probe, command: mode === "argv" ? probe.command : "probe" },
      app: plan.id,
      service,
      plan,
      exec: TestRuntimeProvider.exec,
      runners: {
        process: {
          run: () =>
            Effect.fail(
              new ProcessExecError({
                cmd: canary,
                cwd: canary,
                message: canary,
                cause: canary,
                remediation: canary,
              }),
            ),
        },
        shell: {
          run: () =>
            Effect.fail(
              new ShellExecError({ command: canary, message: canary, stderr: canary, remediation: canary }),
            ),
        },
      },
    };
    // When
    const result = await Effect.runPromise(
      Effect.result(prepareHealthcheckAttempt(input).pipe(Effect.flatMap((attempt) => attempt.run))),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("ServiceExecError");
      expect(JSON.stringify(result.failure)).not.toContain(canary);
      expect(result.failure).not.toHaveProperty("exitCode");
    }
  },
);

test("host readiness text Bun Shell can't run fails while preparing, before any attempt", async () => {
  // Given a runner that would record an attempt
  let attempts = 0;
  const input = {
    probe: { ...probe, command: "test -f ready >&2" },
    app: plan.id,
    service,
    plan,
    exec: TestRuntimeProvider.exec,
    runners: {
      process: { run: () => Effect.die("argv not expected") },
      shell: {
        run: () =>
          Effect.sync(() => {
            attempts += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      },
    },
  };
  // When
  const result = await Effect.runPromise(Effect.result(prepareHealthcheckAttempt(input)));
  // Then the retry loop never starts and the error carries the fix
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("HealthcheckError");
    expect(result.failure.message).toBe(
      "Host readiness command: Column 15: Bun Shell needs an explicit source descriptor in >&2.",
    );
    if (result.failure._tag === "HealthcheckError") expect(result.failure.remediation).toBe("Write 1>&2.");
  }
  expect(attempts).toBe(0);
});
