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
import type { ArtifactRef, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import { buildKeyForService, buildStepsFor } from "./build-key.ts";
import { findCompleteBuildResult, openScratchBuildResults, recordBuildResult } from "./build-results.ts";

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

const buildStepFor = (provider: RuntimeProviderShape, service: ServicePlan): BuildStep => ({
  phase: "artifact",
  service,
  buildKey: buildKeyForService(provider, service),
});

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

const runProviderBuild = (
  provider: RuntimeProviderShape,
  plan: AppPlan,
  step: BuildStep,
): Effect.Effect<ArtifactRef, ProviderError> =>
  Effect.gen(function* () {
    const artifact = step.service.artifact;
    if (artifact?.kind === "ref" && buildStepsFor(step.service).length === 0) {
      return {
        providerId: plan.provider,
        ref: artifact.ref,
        ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
      };
    }
    return yield* Effect.scoped(
      provider.buildArtifact({ app: plan.id, service: step.service.name, plan, buildKey: step.buildKey }),
    );
  });

const serviceWithArtifact = (service: ServicePlan, artifact: ArtifactRef): ServicePlan => ({
  ...service,
  artifact: {
    kind: "ref",
    ref: artifact.ref,
    ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
  },
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
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly stateStore: Context.Tag.Service<typeof StateStore>;
}) =>
  Effect.gen(function* () {
    const { events, paths, provider, plan, service, stateStore } = input;
    const redaction = yield* Effect.serviceOption(RedactionService);
    const redactor =
      redaction._tag === "Some"
        ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
        : identityRedactor;
    const context = redactedBuildContext(redactor, plan, service);
    const step = buildStepFor(provider, service);
    const transcriptPath = transcriptPathFor(paths.roots.userDataRoot, plan, step);
    const bucket = isScratchPlan(plan)
      ? yield* openScratchBuildResults(stateStore).pipe(
          Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)),
        )
      : undefined;
    if (bucket !== undefined) {
      const cached = yield* bucket.get.pipe(
        Effect.mapError((cause) => mapBuildCacheError(provider.id, cause)),
      );
      const complete = findCompleteBuildResult(cached ?? [], {
        buildKey: step.buildKey,
        phase: step.phase,
        service: service.name,
      });
      if (complete?.artifactRef !== undefined) {
        yield* publishBuildStepSkip(events, context, step);
        return serviceWithArtifact(service, { providerId: plan.provider, ref: complete.artifactRef });
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
    const artifact = yield* runProviderBuild(provider, plan, step).pipe(
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
            }).pipe(Effect.mapError((cause) => mapBuildCacheError(provider.id, cause))),
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
          const services = yield* Effect.forEach(
            Object.values(plan.services),
            (service) => buildService({ events, paths, provider, plan, service, stateStore }),
            {
              concurrency: 1,
            },
          );
          return {
            ...plan,
            services: Object.fromEntries(services.map((service) => [service.name, service])),
          };
        }),
    };
  }),
);
