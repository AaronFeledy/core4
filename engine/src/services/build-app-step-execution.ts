import { mapFailures } from "@lando/sdk/command-result";
import { Effect } from "effect";
import type { AppBuildCache, AppStepOutcome, AppStepStart } from "./build-app-disposition.ts";
import { makeAppBuildObservation } from "./build-app-observation.ts";
import type { AppStep } from "./build-app-plan.ts";
import { type AppBuildInput, runAppBuildStep } from "./build-app-step-runner.ts";
import { BuildOwner } from "./build-owner.ts";
import { buildResultsError, findCompleteBuildResult, invalidateAppBuildResult } from "./build-results.ts";
import { openBuildStepOutput } from "./build-step-output.ts";
import { buildTranscriptExists, makeBuildTranscriptPath } from "./build-transcript.ts";

export const makeAppStepExecution = (input: AppBuildInput, cache: AppBuildCache, force: boolean) => {
  const observe = makeAppBuildObservation(input);
  return (
    appStep: AppStep,
    blocking: { readonly labels: readonly string[]; readonly detail: string | undefined },
  ) =>
    Effect.fnUntraced(function* (start: AppStepStart) {
      const { step } = appStep;
      if (blocking.labels.length > 0) return { _tag: "blocked", ...blocking } satisfies AppStepOutcome;
      const containerId = yield* observe(step.service);
      const lookup = {
        buildKey: step.buildKey,
        phase: "app" as const,
        service: step.service,
        step: step.id,
        containerId,
      };
      const cached = force ? undefined : findCompleteBuildResult(cache.entries, lookup);
      if (cached !== undefined) {
        yield* start(
          (yield* buildTranscriptExists(cached.transcriptPath))
            ? { transcriptPath: cached.transcriptPath }
            : {},
        );
        return { _tag: "reused", entry: cached } satisfies AppStepOutcome;
      }
      yield* invalidateAppBuildResult(cache.bucket, lookup).pipe(
        mapFailures((cause) => buildResultsError(input.provider.id, cause)),
      );
      const attempt = {
        transcriptPath: makeBuildTranscriptPath({
          userDataRoot: input.paths.roots.userDataRoot,
          owner: BuildOwner.fromPlan(input.plan),
          phase: "app",
          serviceName: String(step.service),
          buildKey: step.buildKey,
        }),
        containerId,
      };
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const output = yield* openBuildStepOutput({
            events: input.events,
            taskId: step.id,
            transcriptPath: attempt.transcriptPath,
            providerId: input.provider.id,
            userDataRoot: input.paths.roots.userDataRoot,
            redaction: input.redaction,
          });
          yield* start({ transcriptPath: attempt.transcriptPath, attempt });
          const result = yield* runAppBuildStep(input, appStep, output);
          return { _tag: "ran", attempt, result } satisfies AppStepOutcome;
        }),
      );
    });
};
