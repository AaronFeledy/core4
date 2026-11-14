import { redactProviderError } from "@lando/redaction/provider-error";
import { mapFailures } from "@lando/sdk/command-result";
import { ArtifactBuildError, ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { EventService, PathsService, RuntimeProviderShape, StateStore } from "@lando/sdk/services";
import { Cause, type Context, DateTime, Effect, Exit } from "effect";
import { buildAppKind, isScratchPlan } from "./build-app-kind.ts";
import {
  buildStepFor,
  producedImagePresent,
  serviceWithResolvedDigest,
  sourceIdentityMatches,
} from "./build-artifact-cache.ts";
import {
  type ArtifactBuildStep,
  publishArtifactBuildStepSkip,
  redactedBuildContext,
} from "./build-artifact-events.ts";
import { runProviderBuild, serviceWithArtifact } from "./build-artifact-runner.ts";
import { artifactBuildStepsFor } from "./build-key.ts";
import { BuildOwner } from "./build-owner.ts";
import type { BuildRedaction } from "./build-redaction.ts";
import { buildFailureRemediation, buildRemediationSuffix } from "./build-remediation.ts";
import {
  findCompleteBuildResult,
  markBuildResultUsed,
  openAppBuildResults,
  openScratchBuildResults,
  recordBuildResult,
} from "./build-results.ts";
import { openBuildStepOutput } from "./build-step-output.ts";
import type { BuildTaskProgress } from "./build-task-progress.ts";
import { buildTranscriptExists, makeBuildTranscriptPath } from "./build-transcript.ts";
import { resolveSourceArtifact } from "./source-artifact.ts";

const timestamp = DateTime.now;
const encoder = new TextEncoder();

const mapBuildCacheError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the build-results cache.",
    cause,
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
  });

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
      const started = performance.now();
      const bucket = yield* (
        isScratchPlan(plan)
          ? openScratchBuildResults(stateStore)
          : openAppBuildResults(stateStore, BuildOwner.fromPlan(plan))
      ).pipe(mapFailures((cause) => mapBuildCacheError(provider.id, cause)));
      const cached = yield* bucket.get.pipe(mapFailures((cause) => mapBuildCacheError(provider.id, cause)));
      if (!input.refresh && service.pullPolicy !== "build") {
        const complete = findCompleteBuildResult(cached ?? [], {
          buildKey: step.buildKey,
          phase: step.phase,
          service: service.name,
        });
        if (
          complete?.artifactRef !== undefined &&
          sourceIdentityMatches(complete, service, sourceArtifact) &&
          (yield* producedImagePresent(provider, complete))
        ) {
          // The output that is in use must be the newest entry: never age out a key the app runs.
          yield* markBuildResultUsed(bucket, complete).pipe(
            mapFailures((cause) => mapBuildCacheError(provider.id, cause)),
          );
          // A cache hit advertises the transcript recorded by the run that produced it and opens nothing.
          const recordedTranscript = (yield* buildTranscriptExists(complete.transcriptPath))
            ? complete.transcriptPath
            : undefined;
          yield* progress.startTask(service, recordedTranscript);
          yield* publishArtifactBuildStepSkip(events, context, step);
          const digest =
            complete.artifactDigest ??
            (service.artifact?.kind === "ref" && service.artifact.ref === complete.artifactRef
              ? service.artifact.digest
              : undefined);
          const cachedService = serviceWithArtifact(service, {
            providerId: plan.provider,
            ref: complete.artifactRef,
            ...(digest === undefined ? {} : { digest }),
            ...(complete.artifactOrigin === undefined ? {} : { origin: complete.artifactOrigin }),
          });
          yield* progress.completeTask(service, `${String(service.name)} cached`);
          return { service: cachedService, dispatched: false };
        }
      }

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

      const artifact = yield* runProviderBuild({
        provider,
        plan: resolvedPlan,
        service: resolvedService,
        buildKey: step.buildKey,
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
        mapFailures((failure) => {
          if (failure._tag !== "ArtifactBuildError") {
            return redactProviderError(failure, redaction.redactor);
          }
          const outputTail = output.tail();
          return redactProviderError(
            new ArtifactBuildError({
              providerId: failure.providerId,
              operation: failure.operation,
              message: failure.message,
              ...(failure.details === undefined ? {} : { details: failure.details }),
              ...(failure.cause === undefined ? {} : { cause: failure.cause }),
              service: String(service.name),
              transcriptPath,
              ...(outputTail === undefined ? {} : { outputTail }),
              remediation: buildFailureRemediation(
                failure.remediation,
                buildRemediationSuffix(buildAppKind(plan), String(service.name), transcriptPath),
              ),
            }),
            redaction.redactor,
          );
        }),
        Effect.tapError(() =>
          recordBuildResult(bucket, {
            buildKey: step.buildKey,
            service: service.name,
            phase: step.phase,
            outcome: "fail",
            durationMs: performance.now() - started,
            transcriptPath,
          }).pipe(
            mapFailures((cause) => mapBuildCacheError(provider.id, cause)),
            Effect.exit,
            Effect.asVoid,
          ),
        ),
      );
      if (resolvedService.artifact?.kind === "ref" && artifactBuildStepsFor(resolvedService).length === 0) {
        yield* output.note(
          `Using image ${artifact.ref}${artifact.digest === undefined || artifact.ref.includes("@") ? "" : `@${artifact.digest}`}`,
        );
      }
      yield* output.end;
      yield* recordBuildResult(bucket, {
        buildKey: step.buildKey,
        service: service.name,
        phase: step.phase,
        outcome: "complete",
        durationMs: performance.now() - started,
        artifactRef: artifact.ref,
        ...(artifact.digest === undefined ? {} : { artifactDigest: artifact.digest }),
        ...(artifact.origin === undefined ? {} : { artifactOrigin: artifact.origin }),
        ...(service.artifact?.kind !== "ref"
          ? {}
          : {
              sourceArtifactRef: service.artifact.ref,
              ...(sourceArtifact?.digest === undefined
                ? service.artifact.digest === undefined
                  ? {}
                  : { sourceArtifactDigest: service.artifact.digest }
                : { sourceArtifactDigest: sourceArtifact.digest }),
            }),
        transcriptPath,
      }).pipe(mapFailures((cause) => mapBuildCacheError(provider.id, cause)));

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
