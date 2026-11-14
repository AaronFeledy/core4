import { mapFailures } from "@lando/sdk/command-result";
import { BuildStepFailedError, ProviderInternalError } from "@lando/sdk/errors";
import { TaskCompleteEvent, TaskFailEvent, TaskStartEvent } from "@lando/sdk/events";
import type { StateBucket } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import { buildAppKind, isScratchPlan } from "./build-app-kind.ts";
import { makeAppBuildObservation } from "./build-app-observation.ts";
import type { AppStep } from "./build-app-plan.ts";
import {
  type AppBuildInput,
  appStepExitMessage,
  appStepProviderFailureMessage,
  runAppBuildStep,
} from "./build-app-step-runner.ts";
import { BuildOwner } from "./build-owner.ts";
import { buildFailureRemediation, buildRemediationSuffix } from "./build-remediation.ts";
import {
  type BuildResultEntry,
  findCompleteBuildResult,
  markBuildResultUsed,
  recordBuildResult,
} from "./build-results.ts";
import { buildTranscriptExists, makeBuildTranscriptPath } from "./build-transcript.ts";

export const buildResultsError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the build-results cache.",
    cause,
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
  });

export interface AppStepExecution {
  readonly parentId: string;
  readonly bucket: StateBucket<ReadonlyArray<BuildResultEntry>>;
  readonly cached: ReadonlyArray<BuildResultEntry>;
  readonly force: boolean;
  readonly startedIds: Set<string>;
  readonly settledIds: Set<string>;
  readonly succeededIds: Set<string>;
  readonly failures: Map<string, BuildStepFailedError>;
  dispatched: boolean;
}

export const makeAppStepExecution = (input: AppBuildInput, execution: AppStepExecution) => {
  const observe = makeAppBuildObservation(input);
  const appRef = isScratchPlan(input.plan)
    ? ({ kind: "scratch", id: input.redaction.redactor.redactString(input.plan.slug) } as const)
    : ({ kind: "user", id: input.redaction.redactor.redactString(input.plan.slug) } as const);

  return Effect.fnUntraced(function* (
    appStep: AppStep,
    blockedBy: ReadonlyArray<string>,
    detail: string | undefined,
  ) {
    const { step } = appStep;
    const { parentId, bucket } = execution;
    // Failed predecessors must block even a cached step.
    if (blockedBy.length > 0) {
      execution.startedIds.add(step.id);
      const blockedByText = blockedBy.join(", ");
      const message = `Build step ${step.id} for service ${String(step.service)} did not run: blocked by ${blockedByText}${detail === undefined ? "" : `: ${detail}`}.`;
      yield* input.events.publish(
        TaskStartEvent.make({
          taskId: step.id,
          parentId,
          label: `Build ${String(step.service)}`,
          timestamp: yield* DateTime.now,
        }),
      );
      yield* input.events.publish({
        _tag: "build-step-skip",
        eventName: "build-step-skip",
        appRef,
        serviceName: input.redaction.redactor.redactString(step.service),
        providerId: input.redaction.redactor.redactString(input.plan.provider),
        phase: "app",
        buildKey: step.buildKey,
        cached: false,
        reason: "phase-aborted",
        timestamp: yield* DateTime.now,
      });
      yield* input.events.publish(
        TaskFailEvent.make({
          taskId: step.id,
          summary: message,
          durationMs: 0,
          timestamp: yield* DateTime.now,
        }),
      );
      execution.settledIds.add(step.id);
      execution.failures.set(
        step.id,
        new BuildStepFailedError({
          step,
          message,
          remediation: `Resolve the blocking failures (${blockedByText}), then rebuild step ${step.id}.`,
        }),
      );
      return "blocked" as const;
    }

    const containerId = yield* observe(step.service);
    execution.startedIds.add(step.id);
    const cachedHit = execution.force
      ? undefined
      : findCompleteBuildResult(execution.cached, {
          buildKey: step.buildKey,
          phase: "app",
          service: step.service,
          step: step.id,
          containerId,
        });
    if (cachedHit !== undefined) {
      yield* markBuildResultUsed(bucket, cachedHit).pipe(
        mapFailures((cause) => buildResultsError(input.provider.id, cause)),
      );
      yield* input.events.publish(
        TaskStartEvent.make({
          taskId: step.id,
          parentId,
          label: `Build ${String(step.service)}`,
          ...((yield* buildTranscriptExists(cachedHit.transcriptPath))
            ? { transcriptPath: cachedHit.transcriptPath }
            : {}),
          timestamp: yield* DateTime.now,
        }),
      );
      yield* input.events.publish({
        _tag: "build-step-skip",
        eventName: "build-step-skip",
        appRef,
        serviceName: input.redaction.redactor.redactString(step.service),
        providerId: input.redaction.redactor.redactString(input.plan.provider),
        phase: "app",
        buildKey: step.buildKey,
        cached: true,
        reason: "up-to-date",
        timestamp: yield* DateTime.now,
      });
      yield* input.events.publish(
        TaskCompleteEvent.make({
          taskId: step.id,
          summary: `${step.id} cached`,
          durationMs: 0,
          timestamp: yield* DateTime.now,
        }),
      );
      execution.settledIds.add(step.id);
      execution.succeededIds.add(step.id);
      return "succeeded" as const;
    }

    execution.dispatched = true;
    const transcriptPath = makeBuildTranscriptPath({
      userDataRoot: input.paths.roots.userDataRoot,
      owner: BuildOwner.fromPlan(input.plan),
      phase: "app",
      serviceName: String(step.service),
      buildKey: step.buildKey,
    });
    const result = yield* runAppBuildStep(input, appStep, transcriptPath);
    execution.settledIds.add(step.id);
    const failed =
      result.providerFailure !== undefined || (result.exitCode !== undefined && result.exitCode !== 0);
    if (!failed) execution.succeededIds.add(step.id);
    yield* recordBuildResult(bucket, {
      buildKey: step.buildKey,
      service: step.service,
      phase: "app",
      step: step.id,
      ...(containerId === undefined ? {} : { containerId }),
      outcome: failed ? "fail" : "complete",
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      durationMs: result.durationMs,
      transcriptPath,
    }).pipe(mapFailures((cause) => buildResultsError(input.provider.id, cause)));
    if (!failed) return "succeeded" as const;
    const failure = result.providerFailure;
    const kind = buildAppKind(input.plan);
    const remediationSuffix = buildRemediationSuffix(kind, String(step.service), undefined);
    const baseRemediation =
      kind === "scratch"
        ? `Fix step ${step.id}, and rebuild.`
        : `Inspect the build transcript at ${transcriptPath}, fix step ${step.id}, and rebuild.`;
    execution.failures.set(
      step.id,
      new BuildStepFailedError({
        step,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        transcriptPath,
        ...(result.outputTail === undefined ? {} : { outputTail: result.outputTail }),
        ...(failure === undefined
          ? {
              message: appStepExitMessage(step, result.exitCode ?? 0),
              remediation: buildFailureRemediation(baseRemediation, remediationSuffix),
            }
          : {
              message: appStepProviderFailureMessage(step, failure.message),
              cause: failure,
              remediation: buildFailureRemediation(failure.remediation, remediationSuffix),
            }),
      }),
    );
    return "failed" as const;
  });
};
