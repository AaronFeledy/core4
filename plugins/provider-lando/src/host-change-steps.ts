/** Shared pieces of the managed provider's host changes: step shapes and checked step runs. */
import { redactString, standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { HostChangeFailedError, HostChangeStaleError } from "@lando/sdk/errors";
import type { HostChange, HostChangeStep } from "@lando/sdk/schema";
import type { HostChangeStepRunner, ProcessResult } from "@lando/sdk/services";
import { Effect } from "effect";

export const HOST_CHANGE_OWNER = "@lando/provider-lando";
export const SETUP_RERUN = "then rerun `lando setup`";

export const privilegedStep = (
  id: string,
  summary: string,
  argv: readonly [string, ...string[]],
  extra: Partial<Pick<HostChangeStep, "stdin" | "when">> = {},
): HostChangeStep => ({ id, summary, argv, privileged: true, when: "always", ...extra });

export interface FailureText {
  readonly message: string;
  readonly remediation: string;
}

const redacted = (text: string) => redactString(text, standaloneSecretsRedactor({ ...process.env }));

/** Run one declared step and fail the change with `text` when it exits nonzero. */
export const runCheckedStep = Effect.fnUntraced(function* (
  steps: HostChangeStepRunner,
  change: HostChange,
  step: { readonly id: string; readonly stdin?: Uint8Array },
  text: FailureText,
) {
  const result: ProcessResult = yield* steps.run(
    step.id,
    step.stdin === undefined ? undefined : { stdin: step.stdin },
  );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new HostChangeFailedError({
        changeId: change.id,
        stepId: step.id,
        ...text,
        exitCode: result.exitCode,
        stderr: redacted(result.stderr),
      }),
    );
  }
  return result;
});

export const changeFailed = (change: HostChange, text: FailureText) =>
  new HostChangeFailedError({ changeId: change.id, ...text });

export const changeStale = (change: HostChange, reason: string, message: string) =>
  new HostChangeStaleError({
    changeId: change.id,
    reason,
    message,
    remediation: "Rerun `lando setup` so Lando can plan it again.",
  });
