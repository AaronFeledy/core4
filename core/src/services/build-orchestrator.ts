import { type Context, DateTime, Effect, Layer } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import { runAppBuild } from "./build-app-runner.ts";
import {
  type ArtifactBuildStep,
  publishArtifactBuildStepSkip,
  redactedBuildContext,
} from "./build-artifact-events.ts";
import { runProviderBuild, serviceWithArtifact } from "./build-artifact-runner.ts";
import { buildKeyForService } from "./build-key.ts";
import { findCompleteBuildResult, openScratchBuildResults, recordBuildResult } from "./build-results.ts";
import { type BuildTaskProgress, makeBuildTaskProgress } from "./build-task-progress.ts";
import { makeBuildTranscriptPath } from "./build-transcript.ts";

export { BuildOrchestrator } from "@lando/sdk/services";

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

const isScratchPlan = (plan: AppPlan): boolean => String(plan.id).startsWith("scratch-");

const buildStepFor = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<ArtifactBuildStep, ProviderInternalError> =>
  buildKeyForService(provider, service).pipe(
    Effect.map((buildKey) => ({
      phase: "artifact" as const,
      service,
      buildKey,
    })),
  );

const mapBuildCacheError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the scratch build-results cache.",
    cause,
  });

const transcriptPathFor = (userDataRoot: string, plan: AppPlan, step: ArtifactBuildStep) =>
  makeBuildTranscriptPath({
    userDataRoot,
    appId: String(plan.id),
    phase: step.phase,
    serviceName: String(step.service.name),
    buildKey: step.buildKey,
    scratch: isScratchPlan(plan),
  });

const buildService = (input: {
  readonly events: Context.Tag.Service<typeof EventService>;
  readonly paths: Context.Tag.Service<typeof PathsService>;
  readonly provider: RuntimeProviderShape;
  readonly progress: BuildTaskProgress;
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly stateStore: Context.Tag.Service<typeof StateStore>;
}) =>
  Effect.gen(function* () {
    const { events, paths, progress, provider, plan, service, stateStore } = input;
    const redaction = yield* Effect.serviceOption(RedactionService);
    const redactor =
      redaction._tag === "Some"
        ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
        : identityRedactor;
    const context = redactedBuildContext(redactor, plan, service);
    const step = yield* buildStepFor(provider, service);
    const transcriptPath = transcriptPathFor(paths.roots.userDataRoot, plan, step);
    const started = performance.now();
    yield* progress.startTask(service, transcriptPath);
    return yield* Effect.gen(function* () {
      const bucket = isScratchPlan(plan)
        ? yield* openScratchBuildResults(stateStore).pipe(
            Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)),
          )
        : undefined;
      const cached =
        bucket === undefined
          ? undefined
          : yield* bucket.get.pipe(Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)));
      if (bucket !== undefined) {
        const complete = findCompleteBuildResult(cached ?? [], {
          buildKey: step.buildKey,
          phase: step.phase,
          service: service.name,
        });
        if (complete?.artifactRef !== undefined) {
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
          });
          yield* progress.completeTask(service, `${String(service.name)} cached`, 0);
          return cachedService;
        }
      }

      yield* events.publish({
        _tag: "pre-build",
        eventName: "pre-build",
        appRef: { ...context.appRef, root: context.appRoot },
        serviceName: context.serviceName,
        providerId: context.providerId,
        timestamp: timestamp(),
      });

      const artifact = yield* runProviderBuild(provider, plan, service, step.buildKey).pipe(
        Effect.tapError(() =>
          bucket === undefined
            ? Effect.void
            : recordBuildResult(bucket, {
                buildKey: step.buildKey,
                service: service.name,
                phase: step.phase,
                outcome: "fail",
                exitCode: 1,
                durationMs: performance.now() - started,
                transcriptPath,
              }).pipe(
                Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)),
                Effect.exit,
                Effect.asVoid,
              ),
        ),
      );
      if (bucket !== undefined) {
        yield* recordBuildResult(bucket, {
          buildKey: step.buildKey,
          service: service.name,
          phase: step.phase,
          outcome: "complete",
          exitCode: 0,
          durationMs: performance.now() - started,
          artifactRef: artifact.ref,
          ...(artifact.digest === undefined ? {} : { artifactDigest: artifact.digest }),
          transcriptPath,
        }).pipe(Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)));
      }

      yield* events.publish({
        _tag: "post-build",
        eventName: "post-build",
        appRef: { ...context.appRef, root: context.appRoot },
        serviceName: context.serviceName,
        providerId: context.providerId,
        timestamp: timestamp(),
      });
      yield* progress.completeTask(service, `Built ${String(service.name)}`, performance.now() - started);
      return serviceWithArtifact(service, artifact);
    }).pipe(Effect.tapError(() => progress.failTask(service, performance.now() - started)));
  });

const identityRedactor: Pick<Redactor, "redactString"> = { redactString: (text) => text };

export const BuildOrchestratorLive = Layer.effect(
  BuildOrchestrator,
  Effect.gen(function* () {
    const events = yield* EventService;
    const paths = yield* PathsService;
    const registry = yield* RuntimeProviderRegistry;
    const stateStore = yield* StateStore;

    return {
      build: (plan) =>
        Effect.gen(function* () {
          const provider = yield* registry.select(plan);
          const servicePlans = Object.values(plan.services);
          const progress = makeBuildTaskProgress(events, plan);
          const started = performance.now();
          yield* progress.startTree;
          const services = yield* Effect.forEach(
            servicePlans,
            (service) => buildService({ events, paths, progress, provider, plan, service, stateStore }),
            { concurrency: 2 },
          ).pipe(
            Effect.tapError(() => {
              const durationMs = performance.now() - started;
              return Effect.gen(function* () {
                const redaction = yield* Effect.serviceOption(RedactionService);
                const redactor =
                  redaction._tag === "Some"
                    ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
                    : identityRedactor;
                for (const service of progress.unsettledServices()) {
                  const step = yield* buildStepFor(provider, service);
                  const transcriptPath = transcriptPathFor(paths.roots.userDataRoot, plan, step);
                  yield* publishArtifactBuildStepSkip(
                    events,
                    redactedBuildContext(redactor, plan, service),
                    step,
                    "phase-aborted",
                  );
                  yield* progress.abortTask(service, transcriptPath, durationMs);
                }
                yield* progress.failTree(durationMs);
              });
            }),
          );
          yield* progress.completeTree(performance.now() - started);
          return {
            ...plan,
            services: Object.fromEntries(services.map((service) => [service.name, service])),
          };
        }),
      buildApp: (plan, options) =>
        Effect.gen(function* () {
          const provider = yield* registry.select(plan);
          const redaction = yield* Effect.serviceOption(RedactionService);
          const redactor =
            redaction._tag === "Some"
              ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
              : identityRedactor;
          yield* runAppBuild({ events, paths, provider, plan, redactor, stateStore }, options);
        }),
    };
  }),
);
