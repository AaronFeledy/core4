import { availableParallelism } from "node:os";

import { type Context, DateTime, Effect, Stream } from "effect";

import { BuildPhaseFailedError, BuildStepFailedError, ProviderInternalError } from "@lando/sdk/errors";
import {
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { AbsolutePath, AppPlan, BuildStep } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { EventService, PathsService, RuntimeProviderShape, StateStore } from "@lando/sdk/services";

import { type AppStep, appSteps, providerCommand } from "./build-app-plan.ts";
import { findCompleteBuildResult, openAppBuildResults, recordBuildResult } from "./build-results.ts";
import { makeBuildTranscriptPath, openBuildTranscript } from "./build-transcript.ts";

interface AppBuildInput {
  readonly events: Context.Tag.Service<typeof EventService>;
  readonly paths: Context.Tag.Service<typeof PathsService>;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
  readonly redactor: Pick<Redactor, "redactString">;
  readonly stateStore: Context.Tag.Service<typeof StateStore>;
}

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

const cacheError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the build-results cache.",
    cause,
  });

const publishDetailLines = (
  input: Pick<AppBuildInput, "events" | "redactor">,
  step: BuildStep,
  stream: "stdout" | "stderr",
  lines: ReadonlyArray<string>,
) =>
  Effect.forEach(
    lines,
    (line) =>
      input.events.publish(
        TaskDetailEvent.make({
          taskId: step.id,
          stream,
          line: input.redactor.redactString(line),
          timestamp: timestamp(),
        }),
      ),
    { discard: true },
  );

const runStep = (input: AppBuildInput, appStep: AppStep, transcriptPath: AbsolutePath) =>
  Effect.gen(function* () {
    const { command, step } = appStep;
    yield* input.events.publish(
      TaskStartEvent.make({
        taskId: step.id,
        parentId: `build-app-${String(input.plan.id)}`,
        label: `Build ${String(step.service)}`,
        transcriptPath,
        timestamp: timestamp(),
      }),
    );
    const started = performance.now();
    let exitCode = 0;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const pending = { stdout: "", stderr: "" };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const transcript = yield* openBuildTranscript(input.provider.id, transcriptPath);
        yield* input.provider
          .execStream({ app: input.plan.id, service: step.service }, providerCommand(command))
          .pipe(
            Stream.runForEach((chunk) => {
              if ("exitCode" in chunk) {
                exitCode = chunk.exitCode;
                return Effect.void;
              }
              const text = pending[chunk.kind] + decoders[chunk.kind].decode(chunk.chunk, { stream: true });
              const lines = text.split("\n");
              pending[chunk.kind] = lines.pop() ?? "";
              return transcript
                .append(chunk.chunk)
                .pipe(Effect.zipRight(publishDetailLines(input, step, chunk.kind, lines)));
            }),
          );
      }),
    );
    for (const stream of ["stdout", "stderr"] as const) {
      const finalLine = pending[stream] + decoders[stream].decode();
      if (finalLine.length > 0) yield* publishDetailLines(input, step, stream, [finalLine]);
    }
    const durationMs = performance.now() - started;
    if (exitCode === 0) {
      yield* input.events.publish(
        TaskCompleteEvent.make({
          taskId: step.id,
          summary: `${step.id} complete`,
          durationMs,
          timestamp: timestamp(),
        }),
      );
      return { durationMs, exitCode } as const;
    }
    yield* input.events.publish(
      TaskFailEvent.make({
        taskId: step.id,
        summary: `${step.id} failed`,
        exitCode,
        durationMs,
        timestamp: timestamp(),
      }),
    );
    return { durationMs, exitCode } as const;
  });

export const runAppBuild = (input: AppBuildInput) =>
  Effect.gen(function* () {
    const steps = appSteps(input.plan);
    if (steps.length === 0) return;
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
    const results = yield* Effect.forEach(
      steps,
      (appStep) =>
        Effect.gen(function* () {
          const { step } = appStep;
          const transcriptPath = makeBuildTranscriptPath({
            userDataRoot: input.paths.roots.userDataRoot,
            appId: String(input.plan.id),
            phase: "app",
            serviceName: String(step.service),
            buildKey: step.buildKey,
            scratch: false,
          });
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
              appRef: { kind: "user", id: input.redactor.redactString(input.plan.slug) },
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
            return undefined;
          }
          const result = yield* runStep(input, appStep, transcriptPath);
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
    if (failures.length > 0) {
      yield* new BuildPhaseFailedError({
        app: { kind: "user", id: input.plan.id, root: input.plan.root },
        phase: "app",
        failures,
      });
    }
  });
