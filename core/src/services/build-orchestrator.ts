import { type Context, DateTime, Effect, Layer } from "effect";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { BuildOrchestrator, EventService, RuntimeProviderRegistry } from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";

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
    const redaction = yield* Effect.serviceOption(RedactionService);
    const redactor =
      redaction._tag === "Some" ? yield* redaction.value.forProfile("secrets") : identityRedactor;
    const appRef = appRefFor(plan);
    const redactedAppRef = {
      kind: appRef.kind,
      id: redactor.redactString(appRef.id),
      root: redactor.redactString(appRef.root),
    };
    const serviceName = redactor.redactString(service.name);
    const providerId = redactor.redactString(plan.provider);

    yield* events.publish({
      _tag: "pre-build",
      eventName: "pre-build",
      appRef: redactedAppRef,
      serviceName,
      providerId,
      timestamp: timestamp(),
    });

    yield* Effect.scoped(provider.buildArtifact({ app: plan.id, service: service.name }));

    yield* events.publish({
      _tag: "post-build",
      eventName: "post-build",
      appRef: redactedAppRef,
      serviceName,
      providerId,
      timestamp: timestamp(),
    });
  });

const identityRedactor: Pick<Redactor, "redactString"> = { redactString: (text) => text };

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
