import { type Context, DateTime, Effect, Layer } from "effect";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { BuildOrchestrator, EventService, RuntimeProviderRegistry } from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";

export { BuildOrchestrator } from "@lando/sdk/services";

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

const appRefFor = (plan: AppPlan) => ({
  kind: "user" as const,
  id: plan.slug,
  root: plan.root,
});

const buildService = (
  events: Context.Tag.Service<typeof EventService>,
  provider: RuntimeProviderShape,
  plan: AppPlan,
  service: ServicePlan,
) =>
  Effect.gen(function* () {
    const appRef = appRefFor(plan);

    yield* events.publish({
      _tag: "pre-build",
      eventName: "pre-build",
      appRef,
      serviceName: service.name,
      providerId: plan.provider,
      timestamp: timestamp(),
    });

    yield* Effect.scoped(provider.buildArtifact({ app: plan.id, service: service.name }));

    yield* events.publish({
      _tag: "post-build",
      eventName: "post-build",
      appRef,
      serviceName: service.name,
      providerId: plan.provider,
      timestamp: timestamp(),
    });
  });

export const BuildOrchestratorLive = Layer.effect(
  BuildOrchestrator,
  Effect.gen(function* () {
    const events = yield* EventService;
    const registry = yield* RuntimeProviderRegistry;

    return {
      build: (plan) =>
        Effect.gen(function* () {
          const provider = yield* registry.select(plan);
          yield* Effect.forEach(
            Object.values(plan.services),
            (service) => buildService(events, provider, plan, service),
            {
              concurrency: 1,
              discard: true,
            },
          );
        }),
    };
  }),
);
