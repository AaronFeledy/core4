import { type Context, DateTime, Effect, FiberRef, Layer } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ArtifactRef, ProviderError } from "@lando/sdk/services";
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

const selectedProvider = FiberRef.unsafeMake<RuntimeProviderShape | undefined>(undefined);

export const withBuildProvider = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  provider: RuntimeProviderShape,
): Effect.Effect<A, E, R> => effect.pipe(Effect.locally(selectedProvider, provider));

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

const resolveSourceArtifact = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<ArtifactRef | undefined, ProviderError> => {
  const artifact = service.artifact;
  if (artifact?.kind !== "ref") return Effect.succeed(undefined);
  if (!provider.capabilities.artifactPull) {
    return Effect.succeed(
      artifact.digest === undefined
        ? undefined
        : { providerId: service.provider, ref: artifact.ref, digest: artifact.digest },
    );
  }
  return provider.pullArtifact({ ref: artifact.ref });
};

const sourceIdentityMatches = (
  complete: {
    readonly sourceArtifactRef?: string | undefined;
    readonly sourceArtifactDigest?: string | undefined;
  },
  service: ServicePlan,
  sourceArtifact: ArtifactRef | undefined,
): boolean => {
  const planned = service.artifact;
  if (planned?.kind !== "ref") return true;
  const resolvedDigest = sourceArtifact?.digest ?? planned.digest;
  return (
    resolvedDigest !== undefined &&
    complete.sourceArtifactRef === planned.ref &&
    complete.sourceArtifactDigest === resolvedDigest
  );
};

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
    const sourceArtifact = yield* resolveSourceArtifact(provider, service);
    const resolvedService =
      service.artifact?.kind === "ref" && sourceArtifact?.digest !== undefined
        ? {
            ...service,
            artifact: { ...service.artifact, digest: sourceArtifact.digest },
          }
        : service;
    const resolvedPlan =
      resolvedService === service
        ? plan
        : { ...plan, services: { ...plan.services, [service.name]: resolvedService } };
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
        if (complete?.artifactRef !== undefined && sourceIdentityMatches(complete, service, sourceArtifact)) {
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

      const artifact = yield* runProviderBuild({
        provider,
        plan: resolvedPlan,
        service: resolvedService,
        buildKey: step.buildKey,
        ...(sourceArtifact === undefined ? {} : { resolvedSource: sourceArtifact }),
      }).pipe(
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
          const provider = (yield* FiberRef.get(selectedProvider)) ?? (yield* registry.select(plan));
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
          const provider = (yield* FiberRef.get(selectedProvider)) ?? (yield* registry.select(plan));
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
