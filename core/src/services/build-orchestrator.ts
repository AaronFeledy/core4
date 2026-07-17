import { join } from "node:path";

import { type Context, DateTime, Effect, Layer } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, type ServicePlan } from "@lando/sdk/schema";
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
import { runProviderBuild, serviceWithArtifact } from "./build-artifact-runner.ts";
import { buildKeyForService } from "./build-key.ts";
import { findCompleteBuildResult, openScratchBuildResults, recordBuildResult } from "./build-results.ts";
import { type BuildTaskProgress, makeBuildTaskProgress } from "./build-task-progress.ts";

export { BuildOrchestrator } from "@lando/sdk/services";

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

const appRefFor = (plan: AppPlan) => ({
  kind: String(plan.id).startsWith("scratch-") ? ("scratch" as const) : ("user" as const),
  id: plan.slug,
  root: plan.root,
});

const isScratchPlan = (plan: AppPlan): boolean => String(plan.id).startsWith("scratch-");

type BuildPhase = "artifact" | "app";

interface BuildStep {
  readonly phase: BuildPhase;
  readonly service: ServicePlan;
  readonly buildKey: string;
}

interface RedactedBuildContext {
  readonly appRef: {
    readonly kind: "scratch" | "user";
    readonly id: string;
  };
  readonly appRoot: string;
  readonly serviceName: string;
  readonly providerId: string;
}

const buildStepFor = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<BuildStep, ProviderInternalError> =>
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

const redactedBuildContext = (
  redactor: Pick<Redactor, "redactString">,
  plan: AppPlan,
  service: ServicePlan,
): RedactedBuildContext => {
  const appRef = appRefFor(plan);
  return {
    appRef: {
      kind: appRef.kind,
      id: redactor.redactString(appRef.id),
    },
    appRoot: redactor.redactString(appRef.root),
    serviceName: redactor.redactString(service.name),
    providerId: redactor.redactString(plan.provider),
  };
};

const publishBuildStepSkip = (
  events: Context.Tag.Service<typeof EventService>,
  context: RedactedBuildContext,
  step: BuildStep,
) =>
  events.publish({
    _tag: "build-step-skip",
    eventName: "build-step-skip",
    appRef: context.appRef,
    serviceName: context.serviceName,
    providerId: context.providerId,
    phase: step.phase,
    buildKey: step.buildKey,
    cached: true,
    reason: "up-to-date",
    timestamp: timestamp(),
  });

const transcriptPathFor = (
  userDataRoot: string,
  plan: AppPlan,
  step: BuildStep,
): typeof AbsolutePath.Type => {
  const appParts = isScratchPlan(plan) ? ["scratch", String(plan.id)] : [String(plan.id)];
  return AbsolutePath.make(
    join(userDataRoot, "builds", ...appParts, step.phase, String(step.service.name), `${step.buildKey}.log`),
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
    const transcriptPath = transcriptPathFor(paths.roots.userDataRoot, plan, step);
    const bucket = isScratchPlan(plan)
      ? yield* openScratchBuildResults(stateStore).pipe(
          Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)),
        )
      : undefined;
    const cached =
      bucket === undefined
        ? undefined
        : yield* bucket.get.pipe(Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)));
    yield* progress.startTask(service, transcriptPath);
    if (bucket !== undefined) {
      const complete = findCompleteBuildResult(cached ?? [], {
        buildKey: step.buildKey,
        phase: step.phase,
        service: service.name,
      });
      if (complete?.artifactRef !== undefined) {
        yield* publishBuildStepSkip(events, context, step);
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

    const started = performance.now();
    const artifact = yield* runProviderBuild(provider, plan, service, step.buildKey).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          const durationMs = performance.now() - started;
          if (bucket !== undefined) {
            yield* recordBuildResult(bucket, {
              buildKey: step.buildKey,
              service: service.name,
              phase: step.phase,
              outcome: "fail",
              exitCode: 1,
              durationMs,
              transcriptPath,
            }).pipe(Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)));
          }
          yield* progress.failTask(service, durationMs);
        }),
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
            { concurrency: 1 },
          ).pipe(Effect.tapError(() => progress.failTree(performance.now() - started)));
          yield* progress.completeTree(performance.now() - started);
          return {
            ...plan,
            services: Object.fromEntries(services.map((service) => [service.name, service])),
          };
        }),
    };
  }),
);
