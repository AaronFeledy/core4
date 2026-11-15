import { annotateFailureRole, mapFailures, mergeFailure } from "@lando/sdk/command-result";
import { BuildPhaseFailedError, type BuildStepFailedError, ProviderInternalError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { BuildAppError } from "@lando/sdk/services";
import { Cause, DateTime, Effect } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import { type AppBuildAttempt, appBuildResultWarning } from "./build-app-disposition.ts";
import { isScratchPlan } from "./build-app-kind.ts";
import type { AppStep } from "./build-app-plan.ts";
import type { AppBuildInput } from "./build-app-step-runner.ts";
import { BuildOwner } from "./build-owner.ts";
import {
  type AppBuildResult,
  buildResultsError,
  markBuildResultUsed,
  openAppBuildResults,
  recordBuildResult,
} from "./build-results.ts";

type AppStepReceipt = { readonly durationMs: number } & (
  | { readonly outcome: "complete"; readonly exitCode?: number }
  | { readonly outcome: "fail"; readonly failure?: BuildStepFailedError }
);

export const makeAppBuildReceipts = (input: AppBuildInput) => {
  const bucket = openAppBuildResults(input.stateStore, BuildOwner.fromPlan(input.plan));
  const record = Effect.fnUntraced(function* (
    appStep: AppStep,
    attempt: AppBuildAttempt,
    receipt: AppStepReceipt,
  ): Effect.fn.Return<void, BuildAppError> {
    const { step } = appStep;
    const exitCode = receipt.outcome === "complete" ? receipt.exitCode : receipt.failure?.exitCode;
    const persist = Effect.gen(function* () {
      yield* recordBuildResult(yield* bucket, {
        phase: "app",
        service: step.service,
        step: step.id,
        buildKey: step.buildKey,
        ...(attempt.containerId === undefined ? {} : { containerId: attempt.containerId }),
        transcriptPath: attempt.transcriptPath,
        durationMs: receipt.durationMs,
        outcome: receipt.outcome,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    }).pipe(
      mapFailures((cause) =>
        receipt.outcome === "complete"
          ? new ProviderInternalError({
              providerId: input.provider.id,
              operation: "buildResults",
              cause,
              message: input.redaction.redactor.redactString(
                `Build step ${step.id} completed, but its result could not be recorded.`,
              ),
              remediation:
                "Check access to the build-results cache before retrying. The command already ran; retrying may run it again.",
              details: {
                step: step.id,
                service: step.service,
                phase: "app",
                buildKey: step.buildKey,
                transcriptPath: attempt.transcriptPath,
              },
            })
          : buildResultsError(input.provider.id, cause),
      ),
    );
    switch (receipt.outcome) {
      case "complete":
        return yield* persist;
      case "fail":
        return yield* persist.pipe(
          Effect.catchCause((cause): Effect.Effect<void, BuildAppError> => {
            if (!cause.reasons.every(Cause.isFailReason)) return Effect.failCause(cause);
            return Effect.gen(function* () {
              const warning = appBuildResultWarning(input, appStep, cause);
              yield* recordCommandWarning(warning);
              if (!(yield* commandWarningsUseMachineOutput))
                yield* input.events.publish(
                  MessageWarnEvent.make({ body: warning.message, timestamp: yield* DateTime.now }),
                );
            });
          }),
          Effect.catchCause((cause) => {
            // An already-failed body is merged by onExit; only a returned command failure needs a primary here.
            if (receipt.failure === undefined) return Effect.failCause(annotateFailureRole(cause, "cleanup"));
            const primary = new BuildPhaseFailedError({
              app: {
                kind: isScratchPlan(input.plan) ? "scratch" : "user",
                id: input.plan.id,
                root: input.plan.root,
              },
              phase: "app",
              failures: [receipt.failure],
              message: `App build failed: step ${step.id} failed and its result could not be recorded.`,
              remediation:
                "Fix the failed build step and restore access to the build-results cache before rebuilding.",
            });
            return Effect.failCause(mergeFailure(Cause.fail(primary), cause, "cleanup"));
          }),
        );
      default:
        return receipt satisfies never;
    }
  });
  return {
    record,
    load: Effect.gen(function* () {
      const opened = yield* bucket;
      return { bucket: opened, entries: (yield* opened.get) ?? [] };
    }).pipe(mapFailures((cause) => buildResultsError(input.provider.id, cause))),
    markUsed: (entry: AppBuildResult) =>
      bucket.pipe(
        Effect.flatMap((opened) => markBuildResultUsed(opened, entry)),
        mapFailures((cause) => buildResultsError(input.provider.id, cause)),
      ),
  };
};
