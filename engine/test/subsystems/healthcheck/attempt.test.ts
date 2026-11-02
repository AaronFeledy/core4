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
