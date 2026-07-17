import { availableParallelism } from "node:os";

import { Cause, DateTime, Effect, Exit } from "effect";

import { BuildPhaseFailedError, BuildStepFailedError, ProviderInternalError } from "@lando/sdk/errors";
import {
  TaskCompleteEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { BuildStep } from "@lando/sdk/schema";

import { type AppStep, appStepBatches, appSteps } from "./build-app-plan.ts";
import { type AppBuildInput, runAppBuildStep } from "./build-app-step-runner.ts";
import { findCompleteBuildResult, openAppBuildResults, recordBuildResult } from "./build-results.ts";
import { makeBuildTranscriptPath } from "./build-transcript.ts";

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

const cacheError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the build-results cache.",
    cause,
  });

const transcriptPathFor = (input: AppBuildInput, step: BuildStep) =>
  makeBuildTranscriptPath({
    userDataRoot: input.paths.roots.userDataRoot,
    appId: String(input.plan.id),
    phase: "app",
    serviceName: String(step.service),
    buildKey: step.buildKey,
    scratch: String(input.plan.id).startsWith("scratch-"),
  });

const appRefFor = (input: AppBuildInput) =>
  String(input.plan.id).startsWith("scratch-")
    ? ({ kind: "scratch", id: input.redactor.redactString(input.plan.slug) } as const)
    : ({ kind: "user", id: input.redactor.redactString(input.plan.slug) } as const);

export const runAppBuild = (input: AppBuildInput) =>
  Effect.gen(function* () {
    const steps = appSteps(input.plan);
    if (steps.length === 0) return;
    const batchPlan = appStepBatches(steps);
    let batches: ReadonlyArray<ReadonlyArray<AppStep>>;
    switch (batchPlan._tag) {
      case "Cycle":
        return yield* new ProviderInternalError({
          providerId: input.provider.id,
          operation: "buildAppPlan",
          message: "App build steps contain a dependency cycle.",
          details: { edges: batchPlan.edges },
          remediation: "Remove the cyclic app build-step dependencies and retry.",
        });
      case "Batches":
        batches = batchPlan.batches;
    }
    const parentId = `build-app-${String(input.plan.id)}`;
    const bucket = yield* openAppBuildResults(input.stateStore, String(input.plan.id)).pipe(
      Effect.mapError((cause) => cacheError(input.provider.id, cause)),
    );
    const cached =
      (yield* bucket.get.pipe(Effect.mapError((cause) => cacheError(input.provider.id, cause)))) ?? [];
    yield* input.events.publish(
      TaskTreeStartEvent.make({
        parentId,
        label: "Building app dependencies",
        children: steps.map(({ step }) => step.id),
        mode: "list",
        timestamp: timestamp(),
      }),
    );
    const started = performance.now();
    const startedIds = new Set<string>();
    const settledIds = new Set<string>();
    const succeededIds = new Set<string>();
    const failedIds = new Set<string>();
    let treeSettled = false;
    const execution = Effect.gen(function* () {
      const results = [];
      for (const batch of batches) {
        const batchResults = yield* Effect.forEach(
          batch,
          (appStep) =>
            Effect.gen(function* () {
              const { step } = appStep;
              const transcriptPath = transcriptPathFor(input, step);
              startedIds.add(step.id);
              const failedDependencies = step.dependsOn.filter((dependency) => failedIds.has(dependency));
              if (failedDependencies.length > 0) {
                const summary = `${step.id} blocked by ${failedDependencies.join(", ")}`;
                yield* input.events.publish(
                  TaskStartEvent.make({
                    taskId: step.id,
                    parentId,
                    label: `Build ${String(step.service)}`,
                    transcriptPath,
                    timestamp: timestamp(),
                  }),
                );
                yield* input.events.publish({
                  _tag: "build-step-skip",
                  eventName: "build-step-skip",
                  appRef: appRefFor(input),
                  serviceName: input.redactor.redactString(step.service),
                  providerId: input.redactor.redactString(input.plan.provider),
                  phase: "app",
                  buildKey: step.buildKey,
                  cached: false,
                  reason: "phase-aborted",
                  timestamp: timestamp(),
                });
                yield* input.events.publish(
                  TaskFailEvent.make({
                    taskId: step.id,
                    summary,
                    exitCode: 1,
                    durationMs: 0,
                    timestamp: timestamp(),
                  }),
                );
                settledIds.add(step.id);
                failedIds.add(step.id);
                return new BuildStepFailedError({
                  step,
                  exitCode: 1,
                  transcriptPath,
                  summary,
                });
              }
              if (findCompleteBuildResult(cached, step) !== undefined) {
                yield* input.events.publish(
                  TaskStartEvent.make({
                    taskId: step.id,
                    parentId,
                    label: `Build ${String(step.service)}`,
                    transcriptPath,
                    timestamp: timestamp(),
                  }),
                );
                yield* input.events.publish({
                  _tag: "build-step-skip",
                  eventName: "build-step-skip",
                  appRef: appRefFor(input),
                  serviceName: input.redactor.redactString(step.service),
                  providerId: input.redactor.redactString(input.plan.provider),
                  phase: "app",
                  buildKey: step.buildKey,
                  cached: true,
                  reason: "up-to-date",
                  timestamp: timestamp(),
                });
                yield* input.events.publish(
                  TaskCompleteEvent.make({
                    taskId: step.id,
                    summary: `${step.id} cached`,
                    durationMs: 0,
                    timestamp: timestamp(),
                  }),
                );
                settledIds.add(step.id);
                succeededIds.add(step.id);
                return undefined;
              }
              const result = yield* runAppBuildStep(input, appStep, transcriptPath);
              settledIds.add(step.id);
              if (result.exitCode === 0) succeededIds.add(step.id);
              else failedIds.add(step.id);
              yield* recordBuildResult(bucket, {
                buildKey: step.buildKey,
                service: step.service,
                phase: "app",
                outcome: result.exitCode === 0 ? "complete" : "fail",
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                transcriptPath,
              }).pipe(Effect.mapError((cause) => cacheError(input.provider.id, cause)));
              return result.exitCode === 0
                ? undefined
                : new BuildStepFailedError({
                    step,
                    exitCode: result.exitCode,
                    transcriptPath,
                    summary: `${step.id} failed`,
                  });
            }),
          { concurrency: Math.max(1, Math.min(4, availableParallelism())) },
        );
        results.push(...batchResults);
      }
      const failures = results.filter((result): result is BuildStepFailedError => result !== undefined);
      yield* input.events.publish(
        TaskTreeCompleteEvent.make({
          parentId,
          summary: failures.length === 0 ? "App dependencies built" : "App dependency build failed",
          succeeded: steps.length - failures.length,
          failed: failures.length,
          durationMs: performance.now() - started,
          timestamp: timestamp(),
        }),
      );
      treeSettled = true;
      if (failures.length > 0) {
        yield* new BuildPhaseFailedError({
          app: {
            kind: String(input.plan.id).startsWith("scratch-") ? "scratch" : "user",
            id: input.plan.id,
            root: input.plan.root,
          },
          phase: "app",
          failures,
        });
      }
    });
    yield* execution.pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || treeSettled) return Effect.void;
        const summary = Cause.isInterruptedOnly(exit.cause) ? "interrupted" : "failed";
        return Effect.uninterruptible(
          Effect.exit(
            Effect.gen(function* () {
              for (const { step } of steps) {
                if (settledIds.has(step.id)) continue;
                const transcriptPath = transcriptPathFor(input, step);
                if (!startedIds.has(step.id)) {
                  yield* input.events.publish(
                    TaskStartEvent.make({
                      taskId: step.id,
                      parentId,
                      label: `Build ${String(step.service)}`,
                      transcriptPath,
                      timestamp: timestamp(),
                    }),
                  );
                }
                yield* input.events.publish(
                  TaskFailEvent.make({
                    taskId: step.id,
                    summary: `${step.id} ${summary}`,
                    exitCode: 1,
                    durationMs: performance.now() - started,
                    timestamp: timestamp(),
                  }),
                );
              }
              yield* input.events.publish(
                TaskTreeCompleteEvent.make({
                  parentId,
                  summary: `App dependency build ${summary}`,
                  succeeded: succeededIds.size,
                  failed: steps.length - succeededIds.size,
                  durationMs: performance.now() - started,
                  timestamp: timestamp(),
                }),
              );
            }),
          ).pipe(Effect.asVoid),
        );
      }),
    );
  });
