import { RedactionService } from "@lando/redaction/service";
import { identityRedactor, mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ArtifactRef, RuntimeProviderShape } from "@lando/sdk/services";
import {
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { Context, DateTime, Effect, Layer } from "effect";
import { captureHostProbeRunners, validateHealthcheckExecution } from "../subsystems/healthcheck/attempt.ts";
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
import { registerPlanRedaction } from "./plan-redaction.ts";
import { resolveSourceArtifact } from "./source-artifact.ts";

export { BuildOrchestrator } from "@lando/sdk/services";

const timestamp = DateTime.now;

const isScratchPlan = (plan: AppPlan): boolean => String(plan.id).startsWith("scratch-");

const SelectedProvider = Context.Reference<RuntimeProviderShape | undefined>(
  "@lando/engine/SelectedBuildProvider",
  {
    defaultValue: (): RuntimeProviderShape | undefined => undefined,
  },
);

export const withBuildProvider = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  provider: RuntimeProviderShape,
): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(SelectedProvider, provider));

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
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
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

const serviceWithResolvedDigest = (
  service: ServicePlan,
  sourceArtifact: ArtifactRef | undefined,
): ServicePlan => {
  if (service.artifact?.kind !== "ref" || sourceArtifact?.digest === undefined) return service;
  return { ...service, artifact: { ...service.artifact, digest: sourceArtifact.digest } };
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

/**
 * A recorded produced image is reusable only while it still exists locally. The `never` policy is a
 * local lookup that cannot contact a registry; any failure there makes the entry a miss, and the
 * rebuild that follows reports a genuine provider fault itself.
 */
const producedImagePresent = (
  provider: RuntimeProviderShape,
  complete: { readonly artifactRef?: string | undefined; readonly artifactOrigin?: "build" | undefined },
): Effect.Effect<boolean> =>
  complete.artifactOrigin !== "build" || complete.artifactRef === undefined
    ? Effect.succeed(true)
    : provider.pullArtifact({ ref: complete.artifactRef, policy: "never" }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );

const buildService = Effect.fn("BuildOrchestrator.buildService")(function* (input: {
  readonly events: Context.Service.Shape<typeof EventService>;
  readonly paths: Context.Service.Shape<typeof PathsService>;
  readonly provider: RuntimeProviderShape;
  readonly refresh: boolean;
  readonly progress: BuildTaskProgress;
  readonly plan: AppPlan;
  readonly redactionTokens: ReadonlyArray<string>;
  readonly service: ServicePlan;
  readonly stateStore: Context.Service.Shape<typeof StateStore>;
}) {
  const { events, paths, progress, provider, plan, redactionTokens, service, stateStore } = input;
  return yield* Effect.gen(function* () {
    const redaction = yield* Effect.serviceOption(RedactionService);
    const redactor =
      redaction._tag === "Some"
        ? yield* redaction.value.forProfile("secrets", {
            sourceEnv: process.env,
            redactionTokens,
          })
        : identityRedactor;
    const context = redactedBuildContext(redactor, plan, service);
    const sourceArtifact = yield* resolveSourceArtifact(provider, service, {
      refresh: input.refresh,
      stateStore,
      events,
      redactor,
    });
    const resolvedService = serviceWithResolvedDigest(service, sourceArtifact);
    const step = yield* buildStepFor(provider, resolvedService);
    const resolvedPlan =
      resolvedService === service
        ? plan
        : { ...plan, services: { ...plan.services, [service.name]: resolvedService } };
    const transcriptPath = transcriptPathFor(paths.roots.userDataRoot, plan, step);
    const started = performance.now();
    yield* progress.startTask(service, transcriptPath);
    const bucket = isScratchPlan(plan)
      ? yield* openScratchBuildResults(stateStore).pipe(
          mapFailures((cause) => mapBuildCacheError(provider.id, cause)),
        )
      : undefined;
    const cached =
      bucket === undefined
        ? undefined
        : yield* bucket.get.pipe(mapFailures((cause) => mapBuildCacheError(provider.id, cause)));
    // pull_policy: build runs the build every time, so a recorded scratch result is never reused.
    if (bucket !== undefined && service.pullPolicy !== "build") {
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
        return cachedService;
      }
    }

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
              mapFailures((cause) => mapBuildCacheError(provider.id, cause)),
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
    }

    yield* events.publish({
      _tag: "post-build",
      eventName: "post-build",
      appRef: { ...context.appRef, root: context.appRoot },
      serviceName: context.serviceName,
      providerId: context.providerId,
      timestamp: yield* timestamp,
    });
    yield* progress.completeTask(service, `Built ${String(service.name)}`);
    return serviceWithArtifact(service, artifact);
  }).pipe(Effect.tapError(() => progress.failTask(service)));
});

export const layer = Layer.effect(
  BuildOrchestrator,
  Effect.gen(function* () {
    const events = yield* EventService;
    const paths = yield* PathsService;
    const registry = yield* RuntimeProviderRegistry;
    const stateStore = yield* StateStore;
    const hostProbeRunners = yield* captureHostProbeRunners;

    return BuildOrchestrator.of({
      build: Effect.fn("BuildOrchestrator.build")(function* (plan, options) {
        yield* validateHealthcheckExecution(plan, hostProbeRunners);
        const refresh = options?.refresh === true;
        const provider = (yield* SelectedProvider) ?? (yield* registry.select(plan));
        const servicePlans = Object.values(plan.services);
        const { substring: redactionTokens } = yield* registerPlanRedaction(plan);
        const progress = makeBuildTaskProgress(events, plan);
        yield* progress.startTree;
        const services = yield* Effect.forEach(
          servicePlans,
          (service) =>
            buildService({
              events,
              paths,
              progress,
              provider,
              refresh,
              plan,
              redactionTokens,
              service,
              stateStore,
            }),
          { concurrency: 2 },
        ).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              const redaction = yield* Effect.serviceOption(RedactionService);
              const redactor =
                redaction._tag === "Some"
                  ? yield* redaction.value.forProfile("secrets", {
                      sourceEnv: process.env,
                      redactionTokens,
                    })
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
                yield* progress.abortTask(service, transcriptPath);
              }
              yield* progress.failTree;
            }),
          ),
        );
        yield* progress.completeTree;
        return {
          ...plan,
          services: Object.fromEntries(services.map((service) => [service.name, service])),
        };
      }),
      buildApp: Effect.fn("BuildOrchestrator.buildApp")(function* (plan, options) {
        const values = yield* registerPlanRedaction(plan);
        const provider = (yield* SelectedProvider) ?? (yield* registry.select(plan));
        const redaction = yield* Effect.serviceOption(RedactionService);
        const redactor =
          redaction._tag === "Some"
            ? yield* redaction.value.forProfile("secrets", {
                sourceEnv: process.env,
                redactionTokens: values.substring,
                wholeTokenValues: values.wholeToken,
              })
            : identityRedactor;
        yield* runAppBuild(
          { events, paths, provider, plan, redactor, stateStore, hostProbeRunners },
          options,
        );
      }),
    });
  }),
);
