import { type Context, DateTime, Effect, Stream } from "effect";

import { exactSecretReferenceId } from "@lando/landofile/secret-reference";
import { TaskCompleteEvent, TaskDetailEvent, TaskFailEvent, TaskStartEvent } from "@lando/sdk/events";
import { makeLineFramer } from "@lando/sdk/log-follow";
import type { AbsolutePath, AppPlan, BuildStep } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { EventService, PathsService, RuntimeProviderShape, StateStore } from "@lando/sdk/services";

import { type AppStep, providerCommand } from "./build-app-plan.ts";
import { openBuildTranscript } from "./build-transcript.ts";

export interface AppBuildInput {
  readonly events: Context.Tag.Service<typeof EventService>;
  readonly paths: Context.Tag.Service<typeof PathsService>;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
  readonly redactor: Pick<Redactor, "redactString">;
  readonly stateStore: Context.Tag.Service<typeof StateStore>;
}

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

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

export const runAppBuildStep = (input: AppBuildInput, appStep: AppStep, transcriptPath: AbsolutePath) =>
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
    const framers = { stdout: makeLineFramer(), stderr: makeLineFramer() };
    const containsSecretReferences = Object.values(input.plan.services).some((service) =>
      Object.values(service.environment).some((value) => exactSecretReferenceId(value) !== undefined),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const transcript = yield* openBuildTranscript(
          input.provider.id,
          transcriptPath,
          input.paths.roots.userDataRoot,
        );
        yield* input.provider
          .execStream({ app: input.plan.id, service: step.service }, providerCommand(command))
          .pipe(
            Stream.catchAll(() => Stream.make({ exitCode: 1 })),
            Stream.runForEach((chunk) => {
              if ("exitCode" in chunk) {
                exitCode = chunk.exitCode;
                return Effect.void;
              }
              const lines = framers[chunk.kind].feed(chunk.chunk).map((line) => line.text);
              // Explicit secret references opt out of raw transcripts. Frame before redacting so
              // a provider chunk boundary cannot split a resolved value around the redactor.
              const persisted = containsSecretReferences
                ? new TextEncoder().encode(
                    lines.map((line) => `${input.redactor.redactString(line)}\n`).join(""),
                  )
                : chunk.chunk;
              return transcript
                .append(persisted)
                .pipe(Effect.zipRight(publishDetailLines(input, step, chunk.kind, lines)));
            }),
          );
        for (const stream of ["stdout", "stderr"] as const) {
          const lines = framers[stream].flush().map((line) => line.text);
          if (containsSecretReferences) {
            yield* transcript.append(
              new TextEncoder().encode(lines.map((line) => input.redactor.redactString(line)).join("\n")),
            );
          }
          yield* publishDetailLines(input, step, stream, lines);
        }
      }),
    );
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
