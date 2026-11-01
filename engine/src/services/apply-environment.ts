import type { AppPlan } from "@lando/sdk/schema";
import { type ApplyOptions, EnvironmentValueResolver, type RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

export const applyWithResolvedEnvironment = Effect.fn("AppOperation.applyEnvironment")(
  <E = never, R = never>(
    provider: RuntimeProviderShape,
    plan: AppPlan,
    options: ApplyOptions,
    beforeApply?: Effect.Effect<void, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* EnvironmentValueResolver).openSession();
        yield* beforeApply ?? Effect.void;
        return yield* provider.apply(plan, {
          ...options,
          resolveServiceEnvironment: (service) => session.resolveEnvironment(service.environment),
        });
      }),
    ),
);
