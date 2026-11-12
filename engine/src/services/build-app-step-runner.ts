import { redactProviderError } from "@lando/redaction/provider-error";
import type { SecretStoreError } from "@lando/sdk/errors";
import { TaskCompleteEvent, TaskFailEvent, TaskStartEvent } from "@lando/sdk/events";
import type { AbsolutePath, AppPlan, BuildStep } from "@lando/sdk/schema";
import type {
  EventService,
  PathsService,
  ProviderError,
  RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { type Context, DateTime, Effect, Stream } from "effect";
import type { HostProbeRunners } from "../subsystems/healthcheck/attempt.ts";

import { type AppStep, providerCommand } from "./build-app-plan.ts";
import type { BuildRedaction } from "./build-redaction.ts";
import { type BuildStepOutputError, openBuildStepOutput } from "./build-step-output.ts";

export interface AppBuildInput {
  readonly hostProbeRunners?: HostProbeRunners;
  readonly events: Context.Service.Shape<typeof EventService>;
  readonly paths: Context.Service.Shape<typeof PathsService>;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
  readonly redaction: BuildRedaction;
  readonly stateStore: Context.Service.Shape<typeof StateStore>;
}

export interface AppBuildStepResult {
  readonly durationMs: number;
  /** Present only when the provider stream reported a command exit. */
  readonly exitCode?: number;
  readonly outputTail?: string;
  /** Provider failure, already redacted, when the stream itself failed. */
  readonly providerFailure?: ProviderError;
}

const timestamp = DateTime.now;

const isSecretStoreError = (failure: ProviderError): failure is SecretStoreError =>
  failure._tag === "SecretNotFoundError" ||
  failure._tag === "SecretStoreUnavailableError" ||
  failure._tag === "SecretReferenceInvalidError";

export const appStepExitMessage = (step: BuildStep, exitCode: number): string =>
  `Build step ${step.id} for service ${String(step.service)} exited with code ${exitCode}.`;

export const appStepProviderFailureMessage = (step: BuildStep, providerMessage: string): string =>
  `Build step ${step.id} for service ${String(step.service)} did not complete: ${providerMessage}`;

export const runAppBuildStep = Effect.fn("BuildOrchestrator.runAppBuildStep")(function* (
  input: AppBuildInput,
  appStep: AppStep,
  transcriptPath: AbsolutePath,
): Effect.fn.Return<AppBuildStepResult, BuildStepOutputError | SecretStoreError> {
  const { command, step } = appStep;
  const started = performance.now();
  let exitCode: number | undefined;
  let providerFailure: ProviderError | undefined;
  let secretStoreFailure: SecretStoreError | undefined;
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const recorder = yield* openBuildStepOutput({
        events: input.events,
        taskId: step.id,
        transcriptPath,
        providerId: input.provider.id,
        userDataRoot: input.paths.roots.userDataRoot,
        redaction: input.redaction,
      });
      yield* input.events.publish(
        TaskStartEvent.make({
          taskId: step.id,
          parentId: `build-app-${String(input.plan.id)}`,
          label: `Build ${String(step.service)}`,
          transcriptPath,
          timestamp: yield* timestamp,
        }),
      );
      yield* input.provider
        .execStream(
          {
            app: input.plan.id,
            service: step.service,
            ...(step.user === undefined ? {} : { user: step.user }),
          },
          providerCommand(command),
        )
        .pipe(
          Stream.catch((failure) => {
            if (isSecretStoreError(failure)) secretStoreFailure = failure;
            else providerFailure = failure;
            return Stream.empty;
          }),
          Stream.runForEach((chunk) =>
            "exitCode" in chunk
              ? Effect.sync(() => {
                  exitCode = chunk.exitCode;
                })
              : recorder.write(chunk.kind, chunk.chunk),
          ),
        );
      // Flush first: an unterminated last line must land before the error line that ends the transcript.
      yield* recorder.end;
      if (secretStoreFailure !== undefined) return { recorder, secretStoreFailure } as const;
      if (providerFailure !== undefined) {
        const redacted = redactProviderError(providerFailure, input.redaction.redactor);
        providerFailure = redacted;
        yield* recorder.note(`Error: ${redacted.message}`);
      } else if (exitCode !== undefined && exitCode !== 0) {
        yield* recorder.note(`Error: ${appStepExitMessage(step, exitCode)}`);
      }
      return { recorder, secretStoreFailure: undefined } as const;
    }),
  );
  if (output.secretStoreFailure !== undefined) return yield* Effect.fail(output.secretStoreFailure);
  const durationMs = performance.now() - started;
  const outputTail = output.recorder.tail();
  const observedExitCode = providerFailure === undefined ? exitCode : undefined;
  const result: AppBuildStepResult = {
    durationMs,
    ...(observedExitCode === undefined ? {} : { exitCode: observedExitCode }),
    ...(outputTail === undefined ? {} : { outputTail }),
    ...(providerFailure === undefined ? {} : { providerFailure }),
  };
  if (providerFailure === undefined && (exitCode === undefined || exitCode === 0)) {
    yield* input.events.publish(
      TaskCompleteEvent.make({
        taskId: step.id,
        summary: `${step.id} complete`,
        durationMs,
        timestamp: yield* timestamp,
      }),
    );
    return result;
  }
  yield* input.events.publish(
    TaskFailEvent.make({
      taskId: step.id,
      summary: `${step.id} failed`,
      ...(observedExitCode === undefined ? {} : { exitCode: observedExitCode }),
      durationMs,
      timestamp: yield* timestamp,
    }),
  );
  return result;
});
