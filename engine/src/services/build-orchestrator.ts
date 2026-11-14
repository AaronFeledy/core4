import { type ServicePlan, clonedServiceParent } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import {
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { Context, Effect, Layer } from "effect";
import { captureHostProbeRunners, validateHealthcheckExecution } from "../subsystems/healthcheck/attempt.ts";
import { runAppBuild } from "./build-app-runner.ts";
import { buildStepFor } from "./build-artifact-cache.ts";
import { publishArtifactBuildStepSkip, redactedBuildContext } from "./build-artifact-events.ts";
import { buildService } from "./build-artifact-service.ts";
import { BuildOwner } from "./build-owner.ts";
import { registerBuildRedaction } from "./build-redaction.ts";
import { makeBuildTaskProgress } from "./build-task-progress.ts";
import { sweepAppBuildTranscripts } from "./build-transcript-cleanup.ts";

export { BuildOrchestrator } from "@lando/sdk/services";

const SelectedProvider = Context.Reference<RuntimeProviderShape | undefined>(
  "@lando/engine/SelectedBuildProvider",
  { defaultValue: (): RuntimeProviderShape | undefined => undefined },
);

export const withBuildProvider = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  provider: RuntimeProviderShape,
): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(SelectedProvider, provider));

const buildWaves = (services: ReadonlyArray<ServicePlan>): ReadonlyArray<ReadonlyArray<ServicePlan>> => {
  const names = new Set(services.map((service) => String(service.name)));
  const waitsForParent = (service: ServicePlan): boolean => {
    const parent = clonedServiceParent(service);
    return parent !== undefined && names.has(parent);
  };
  return [services.filter((service) => !waitsForParent(service)), services.filter(waitsForParent)].filter(
    (wave) => wave.length > 0,
  );
};

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
        const redaction = yield* registerBuildRedaction(plan);
        const progress = makeBuildTaskProgress(events, plan);
        yield* progress.startTree;
        const buildBatch = (batch: ReadonlyArray<ServicePlan>) =>
          Effect.forEach(
            batch,
            (service) =>
              buildService({
                events,
                paths,
                progress,
                provider,
                refresh,
                plan,
                redaction,
                service,
                stateStore,
              }),
            { concurrency: 2 },
          );
        const built = yield* Effect.forEach(buildWaves(Object.values(plan.services)), buildBatch, {
          concurrency: 1,
        }).pipe(
          Effect.map((waves) => waves.flat()),
          Effect.tapError(() =>
            Effect.gen(function* () {
              for (const service of progress.unsettledServices()) {
                const step = yield* buildStepFor(provider, service);
                yield* publishArtifactBuildStepSkip(
                  events,
                  redactedBuildContext(redaction.redactor, plan, service),
                  step,
                  "phase-aborted",
                );
                yield* progress.abortTask(service);
              }
              yield* progress.failTree;
            }),
          ),
        );
        const services = { ...plan.services };
        for (const { service } of built) services[service.name] = service;
        if (built.some((entry) => entry.dispatched))
          yield* sweepAppBuildTranscripts({
            providerId: provider.id,
            userDataRoot: paths.roots.userDataRoot,
            owner: BuildOwner.fromPlan(plan),
            phase: "artifact",
            stateStore,
            redact: (text) => redaction.redactor.redactString(text),
          });
        yield* progress.completeTree;
        return { ...plan, services };
      }),
      buildApp: Effect.fn("BuildOrchestrator.buildApp")(function* (plan, options) {
        const redaction = yield* registerBuildRedaction(plan);
        const provider = (yield* SelectedProvider) ?? (yield* registry.select(plan));
        yield* runAppBuild(
          { events, paths, provider, plan, redaction, stateStore, hostProbeRunners },
          options,
        );
      }),
    });
  }),
);
