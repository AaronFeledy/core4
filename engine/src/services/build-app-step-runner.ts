import { redactProviderError } from "@lando/redaction/provider-error";
import { mapDefectCause, mapStreamFailures } from "@lando/sdk/command-result";
import type { SecretStoreError } from "@lando/sdk/errors";
import type { AppPlan, BuildStep } from "@lando/sdk/schema";
import type {
  EventService,
  PathsService,
  ProviderError,
  RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { Cause, type Context, Effect, Stream } from "effect";
import type { HostProbeRunners } from "../subsystems/healthcheck/attempt.ts";
import { type AppStep, providerCommand } from "./build-app-plan.ts";
import type { BuildRedaction } from "./build-redaction.ts";
import type { BuildStepOutput, BuildStepOutputError } from "./build-step-output.ts";

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
  readonly exitCode?: number;
  readonly outputTail?: string;
  readonly providerFailure?: ProviderError;
}

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
  output: BuildStepOutput,
): Effect.fn.Return<AppBuildStepResult, BuildStepOutputError | ProviderError> {
  const { command, step } = appStep;
  const started = performance.now();
  let exitCode: number | undefined;
  const providerFailure = yield* input.provider
    .execStream(
      { app: input.plan.id, service: step.service, ...(step.user === undefined ? {} : { user: step.user }) },
      providerCommand(command),
    )
    .pipe(
      Stream.scoped,
      mapStreamFailures((failure) =>
        isSecretStoreError(failure) ? failure : redactProviderError(failure, input.redaction.redactor),
      ),
      Stream.catchCause((cause) =>
        Stream.failCause(mapDefectCause(cause, (defect) => input.redaction.redactor.redactValue(defect))),
      ),
      Stream.catchCause((cause) => {
        const reason = cause.reasons[0];
        // Only a single ordinary provider failure is a scheduler disposition. Mixed causes and secrets propagate intact.
        return cause.reasons.length === 1 &&
          reason !== undefined &&
          Cause.isFailReason(reason) &&
          !isSecretStoreError(reason.error)
          ? Stream.make(reason.error)
          : Stream.failCause(cause);
      }),
      Stream.runFoldEffect(
        (): ProviderError | undefined => undefined,
        (failure, chunk) => {
          if ("_tag" in chunk) return Effect.succeed(chunk);
          if ("exitCode" in chunk) {
            exitCode = chunk.exitCode;
            return Effect.succeed(failure);
          }
          return output.write(chunk.kind, chunk.chunk).pipe(Effect.as(failure));
        },
      ),
    );
  yield* output.end;
  if (providerFailure !== undefined) yield* output.note(`Error: ${providerFailure.message}`);
  else if (exitCode !== undefined && exitCode !== 0)
    yield* output.note(`Error: ${appStepExitMessage(step, exitCode)}`);
  const outputTail = output.tail();
  return {
    durationMs: performance.now() - started,
    ...(providerFailure !== undefined || exitCode === undefined ? {} : { exitCode }),
    ...(outputTail === undefined ? {} : { outputTail }),
    ...(providerFailure === undefined ? {} : { providerFailure }),
  };
});
