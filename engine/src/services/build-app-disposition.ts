import type { ScheduleOutcome } from "@lando/container-runtime/dependency-schedule";
import { failureOutcomeFromCause, taggedErrorJson } from "@lando/sdk/command-result";
import { BuildStepFailedError, type EventError } from "@lando/sdk/errors";
import type { AbsolutePath, CommandWarning } from "@lando/sdk/schema";
import type { BuildAppError, StateBucket } from "@lando/sdk/services";
import { Cause, type Effect } from "effect";
import { buildAppKind } from "./build-app-kind.ts";
import type { AppStep } from "./build-app-plan.ts";
import {
  type AppBuildInput,
  type AppBuildStepResult,
  appStepExitMessage,
  appStepProviderFailureMessage,
} from "./build-app-step-runner.ts";
import { buildFailureRemediation, buildRemediationSuffix } from "./build-remediation.ts";
import type { AppBuildResult } from "./build-results.ts";

export interface AppBuildCache {
  readonly bucket: StateBucket<readonly AppBuildResult[]>;
  readonly entries: readonly AppBuildResult[];
}
export interface AppBuildAttempt {
  readonly transcriptPath: AbsolutePath;
  readonly containerId: string | undefined;
}
export interface AppStepStarted {
  readonly transcriptPath?: AbsolutePath;
  readonly attempt?: AppBuildAttempt;
}
export type AppStepStart = (started: AppStepStarted) => Effect.Effect<void, EventError>;
export type AppStepOutcome =
  | { readonly _tag: "blocked"; readonly labels: readonly string[]; readonly detail: string | undefined }
  | { readonly _tag: "reused"; readonly entry: AppBuildResult }
  | { readonly _tag: "ran"; readonly attempt: AppBuildAttempt; readonly result: AppBuildStepResult };
export interface AppStepDisposition {
  readonly outcome: ScheduleOutcome;
  readonly summary: string;
  readonly durationMs: number;
  readonly failure?: BuildStepFailedError;
}

export const failedAppStepDisposition = (
  appStep: AppStep,
  cause: Cause.Cause<BuildAppError>,
  durationMs: number,
): AppStepDisposition => {
  const failure = failureOutcomeFromCause(cause);
  const detail = failure.kind === "typed" ? taggedErrorJson(failure.error).message : undefined;
  return {
    outcome: "failed",
    summary: detail ?? `${appStep.subject} ${Cause.hasInterruptsOnly(cause) ? "interrupted" : "failed"}`,
    durationMs,
  };
};

export const appBuildResultWarning = (
  input: AppBuildInput,
  appStep: AppStep,
  cause: Cause.Cause<BuildAppError>,
): CommandWarning => ({
  code: "LANDO_BUILD_RESULT_NOT_RECORDED",
  message: input.redaction.redactor.redactString(
    `Unable to record the failed build result for ${appStep.step.id}. ${Cause.pretty(cause)}`,
  ),
  remediation: "Restore access to the build-results cache before rebuilding.",
  context: {
    step: input.redaction.redactor.redactString(appStep.step.id),
    service: input.redaction.redactor.redactString(appStep.step.service),
    cause: input.redaction.redactor.redactString(Cause.pretty(cause)),
  },
});

export const appStepDisposition = (
  input: AppBuildInput,
  appStep: AppStep,
  outcome: AppStepOutcome,
): AppStepDisposition => {
  const { step, subject } = appStep;
  switch (outcome._tag) {
    case "blocked": {
      const blockedBy = outcome.labels.join(", ");
      const reason = `blocked by ${blockedBy}${outcome.detail === undefined ? "" : `: ${outcome.detail}`}`;
      const message = `Build step ${step.id} for service ${String(step.service)} did not run: ${reason}.`;
      return {
        outcome: "blocked",
        summary: `${subject} did not run: ${reason}`,
        durationMs: 0,
        failure: new BuildStepFailedError({
          step,
          message,
          remediation: `Resolve the blocking failures (${blockedBy}), then run lando start.`,
        }),
      };
    }
    case "reused":
      return { outcome: "succeeded", summary: `${subject} cached`, durationMs: 0 };
    case "ran": {
      const { result, attempt } = outcome;
      const failure = result.providerFailure;
      if (result.exitCode === 0)
        return { outcome: "succeeded", summary: `Built ${subject}`, durationMs: result.durationMs };
      const { command: _, ...stepReference } = step;
      const unobserved = result.failureOrigin === "unobserved-exit";
      const kind = buildAppKind(input.plan);
      const baseRemediation =
        kind === "scratch"
          ? `Fix step ${step.id}, then run lando start.`
          : `Inspect the build transcript at ${attempt.transcriptPath}, fix step ${step.id}, then run lando start.`;
      return {
        outcome: "failed",
        summary: `${subject} failed`,
        durationMs: result.durationMs,
        failure: new BuildStepFailedError({
          step: unobserved ? stepReference : step,
          transcriptPath: attempt.transcriptPath,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.outputTail === undefined ? {} : { outputTail: result.outputTail }),
          ...(failure === undefined ? {} : { cause: failure }),
          message:
            failure === undefined
              ? appStepExitMessage(step, result.exitCode)
              : appStepProviderFailureMessage(step, failure.message),
          remediation: buildFailureRemediation(
            failure?.remediation ?? baseRemediation,
            buildRemediationSuffix(
              kind,
              String(step.service),
              unobserved ? attempt.transcriptPath : undefined,
            ),
          ),
        }),
      };
    }
    default:
      return outcome satisfies never;
  }
};
