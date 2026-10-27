import { RedactionService, type RedactionServiceShape } from "@lando/redaction/service";
import type { AppPlan } from "@lando/sdk/schema";
import { EnvironmentValueResolver } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import * as Resolver from "../src/services/environment-value-resolver.ts";
import * as EnvSecretStore from "../src/services/secret-store.ts";

export const testEnvironmentResolverLayer = Resolver.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EnvSecretStore.layer, RedactionService.layer)),
);

export const testEnvironmentResolverLayerFor = (redaction: RedactionServiceShape) =>
  Resolver.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(EnvSecretStore.layer, Layer.succeed(RedactionService, redaction))),
  );

export const resolvePlanEnvironment = (plan: AppPlan) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      const entries = yield* Effect.forEach(Object.values(plan.services), (service) =>
        session
          .resolveEnvironment(service.environment)
          .pipe(Effect.map((env) => [service.name, env] as const)),
      );
      return Object.fromEntries(entries);
    }),
  ).pipe(Effect.provide(Resolver.layer.pipe(Layer.provide(RedactionService.layer))));
