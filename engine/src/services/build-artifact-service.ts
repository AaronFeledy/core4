import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type EventService,
  PathsService,
  type RuntimeProviderShape,
  type StateStore,
} from "@lando/sdk/services";
import { Cause, type Context, DateTime, Effect, Exit, type Option } from "effect";
import {
  buildStepFor,
  producedImagePresent,
  serviceWithCachedArtifact,
  serviceWithResolvedDigest,
  sourceArtifactReceipt,
  sourceIdentityMatches,
} from "./build-artifact-cache.ts";
import {
  type ArtifactBuildStep,
  publishArtifactBuildStepSkip,
  redactedBuildContext,
} from "./build-artifact-events.ts";
import { artifactBuildFailure } from "./build-artifact-failure.ts";
import { withBuiltArtifactsLock } from "./build-artifact-lock.ts";
import { BUILT_ARTIFACT_STORE_LABEL, artifactBuildName } from "./build-artifact-name.ts";
import { openArtifactBuildRecording } from "./build-artifact-recording.ts";
import {
  type ArtifactBuildResult,
  openArtifactBuildResults,
  useArtifactBuildResult,
} from "./build-artifact-results.ts";
import { dispatchesArtifactBuild, runProviderBuild, serviceWithArtifact } from "./build-artifact-runner.ts";
import { artifactBuildStepsFor } from "./build-key.ts";
import { BuildOwner } from "./build-owner.ts";
import type { BuildRedaction } from "./build-redaction.ts";
import { buildResultsError } from "./build-results.ts";
import { type BuildSourceStore, acquireBuildTrees } from "./build-source-store.ts";
import { openBuildStepOutput } from "./build-step-output.ts";
import type { BuildTaskProgress } from "./build-task-progress.ts";
import { buildTranscriptExists, makeBuildTranscriptPath } from "./build-transcript.ts";
import { resolveSourceArtifact } from "./source-artifact.ts";

const timestamp = DateTime.now;
const encoder = new TextEncoder();

const transcriptPathFor = (userDataRoot: string, plan: AppPlan, step: ArtifactBuildStep) =>
  makeBuildTranscriptPath({
    userDataRoot,
    owner: BuildOwner.fromPlan(plan),
    phase: step.phase,
    serviceName: String(step.service.name),
    buildKey: step.buildKey,
  });

export const buildService = Effect.fn("BuildOrchestrator.buildService")(function* (input: {
  readonly events: Context.Service.Shape<typeof EventService>;
  readonly paths: Context.Service.Shape<typeof PathsService>;
  readonly provider: RuntimeProviderShape;
  readonly refresh: boolean;
  readonly progress: BuildTaskProgress;
  readonly plan: AppPlan;
  readonly redaction: BuildRedaction;
  readonly service: ServicePlan;
  readonly stateStore: Context.Service.Shape<typeof StateStore>;
  readonly sourceStore: Option.Option<Context.Service.Shape<typeof BuildSourceStore>>;
  readonly storeKey: string;
  readonly cachedArtifacts: readonly ArtifactBuildResult[];
  readonly activity: { dispatched: boolean; dropped: boolean };
}) {
  const { events, paths, progress, provider, plan, redaction, service, stateStore } = input;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = redactedBuildContext(redaction.redactor, plan, service);
      const sourceArtifact = yield* resolveSourceArtifact(provider, service, {
        refresh: input.refresh,
        stateStore,
        events,
        redactor: redaction.redactor,
      });
      const resolvedService = serviceWithResolvedDigest(service, sourceArtifact);
      const step = yield* buildStepFor(provider, resolvedService);
      const resolvedPlan =
        resolvedService === service
          ? plan
          : { ...plan, services: { ...plan.services, [service.name]: resolvedService } };
      const transcriptPath = transcriptPathFor(paths.roots.userDataRoot, plan, step);
      const owner = BuildOwner.fromPlan(plan).key;
      const bucket = yield* openArtifactBuildResults(stateStore).pipe(
        mapFailures((cause) => buildResultsError(provider.id, cause)),
      );
      if (
        !input.refresh &&
        service.pullPolicy !== "build" &&
        input.cachedArtifacts.some(
          (entry) =>
            entry.providerId === provider.id &&
            entry.service === service.name &&
            entry.buildKey === step.buildKey &&
            entry.outcome === "complete",
        )
      ) {
        const hit = yield* withBuiltArtifactsLock(
          useArtifactBuildResult(
            bucket,
            { owner, providerId: String(provider.id), buildKey: step.buildKey, service: service.name },
            (candidate) =>
              sourceIdentityMatches(candidate, service, sourceArtifact)
                ? producedImagePresent(provider, candidate)
                : Effect.succeed(false),
          ),
        ).pipe(
          Effect.provideService(PathsService, paths),
          mapFailures((cause) => buildResultsError(provider.id, cause)),
        );
        if (hit !== undefined) {
          const complete = hit.entry;
          input.activity.dropped ||= hit.dropped.length > 0;
          // A cache hit advertises the transcript recorded by the run that produced it and opens nothing.
          const recordedTranscript = (yield* buildTranscriptExists(complete.transcriptPath))
            ? complete.transcriptPath
            : undefined;
          yield* progress.startTask(service, recordedTranscript);
          yield* publishArtifactBuildStepSkip(events, context, step);
          yield* progress.completeTask(service, `${String(service.name)} cached`);
          return { service: serviceWithCachedArtifact(service, complete), dispatched: false };
        }
      }

      const builds = dispatchesArtifactBuild(resolvedService);
      const ref = artifactBuildName(input.storeKey, provider.id, service.name, step.buildKey);
      const intendedRef =
        !builds && resolvedService.artifact?.kind === "ref" ? resolvedService.artifact.ref : ref;
      const receipt = {
        owner,
        providerId: String(provider.id),
        buildKey: step.buildKey,
        service: service.name,
        phase: "artifact" as const,
        artifactRef: intendedRef,
        transcriptPath,
        ...(builds ? { artifactOrigin: "build" as const } : {}),
      };
      const recording = yield* openArtifactBuildRecording(bucket, receipt, input.activity).pipe(
        Effect.provideService(PathsService, paths),
      );

      // Open the recorder before announcing the task so the advertised transcript is being written.
      const output = yield* openBuildStepOutput({
        events,
        taskId: String(service.name),
        transcriptPath,
        providerId: provider.id,
        userDataRoot: paths.roots.userDataRoot,
        redaction,
      });
      yield* progress.startTask(service, transcriptPath);

      yield* events.publish({
        _tag: "pre-build",
        eventName: "pre-build",
        appRef: { ...context.appRef, root: context.appRoot },
        serviceName: context.serviceName,
        providerId: context.providerId,
        timestamp: yield* timestamp,
      });

      const contextTrees = builds
        ? yield* acquireBuildTrees(resolvedService, input.sourceStore, {
            providerId: provider.id,
            redact: (text) => redaction.redactor.redactString(text),
          })
        : [];
      if (builds) yield* recording.dispatch;
      const artifact = yield* runProviderBuild({
        labels: { [BUILT_ARTIFACT_STORE_LABEL]: input.storeKey },
        provider,
        plan: resolvedPlan,
        service: resolvedService,
        buildKey: step.buildKey,
        ref,
        ...(contextTrees.length === 0 ? {} : { contextTrees }),
        ...(sourceArtifact === undefined ? {} : { resolvedSource: sourceArtifact }),
        onOutput: (text) =>
          output.write("stdout", encoder.encode(text)).pipe(
            mapFailures((cause) =>
              cause._tag === "EventError"
                ? new ProviderInternalError({
                    providerId: provider.id,
                    operation: "buildArtifact",
                    message: "Unable to publish build output.",
                    cause,
                    remediation:
                      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
                  })
                : cause,
            ),
          ),
      }).pipe(
        // Flush and record the failure before the error is rebuilt. The build failure stays primary
        // when the transcript itself cannot be written.
        Effect.tapError((failure) =>
          output.end.pipe(Effect.andThen(output.note(`Error: ${failure.message}`)), Effect.ignore),
        ),
        mapFailures((failure) =>
          artifactBuildFailure(failure, {
            redactor: redaction.redactor,
            plan,
            service: String(service.name),
            transcriptPath,
            outputTail: output.tail(),
          }),
        ),
      );
      if (resolvedService.artifact?.kind === "ref" && artifactBuildStepsFor(resolvedService).length === 0) {
        yield* output.note(
          `Using image ${artifact.ref}${artifact.digest === undefined || artifact.ref.includes("@") ? "" : `@${artifact.digest}`}`,
        );
      }
      yield* output.end;
      yield* recording
        .complete({
          artifactRef: artifact.ref,
          ...(artifact.digest === undefined ? {} : { artifactDigest: artifact.digest }),
          ...(artifact.origin === undefined ? {} : { artifactOrigin: artifact.origin }),
          ...sourceArtifactReceipt(service, sourceArtifact),
        })
        .pipe(mapFailures((cause) => buildResultsError(provider.id, cause)));

      yield* events.publish({
        _tag: "post-build",
        eventName: "post-build",
        appRef: { ...context.appRef, root: context.appRoot },
        serviceName: context.serviceName,
        providerId: context.providerId,
        timestamp: yield* timestamp,
      });
      yield* progress.completeTask(service, `Built ${String(service.name)}`);
      return { service: serviceWithArtifact(service, artifact), dispatched: true };
    }),
  ).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void;
      return Cause.hasInterruptsOnly(exit.cause) ? progress.abortTask(service) : progress.failTask(service);
    }),
  );
});
