import { Context, Effect } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";

export type GlobalRouterStartupPlan = Pick<AppPlan, "services">;

const GlobalRouterStartupPlanObserver = Context.Reference<
  ((plan: GlobalRouterStartupPlan) => Effect.Effect<void>) | undefined
>("@lando/engine/GlobalRouterStartupPlanObserver", { defaultValue: () => undefined });

/** Record applied services before readiness or route publication can fail. */
export const recordGlobalRouterStartupPlan = Effect.fn("GlobalApp.recordRouterStartupPlan")(function* (
  plan: GlobalRouterStartupPlan,
) {
  const observer = yield* GlobalRouterStartupPlanObserver;
  if (observer !== undefined) yield* observer(plan);
});

export const withGlobalRouterStartupPlanObserver = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  observer: (plan: GlobalRouterStartupPlan) => Effect.Effect<void>,
): Effect.Effect<A, E, R> => body.pipe(Effect.provideService(GlobalRouterStartupPlanObserver, observer));

/** Revalidate only the router actually admitted and applied by this operation. */
export const revalidateAppliedGlobalRouterStartup = Effect.fn("GlobalApp.revalidateAppliedRouter")(function* (
  plan: GlobalRouterStartupPlan | undefined,
) {
  const router = yield* RouterService;
  if (!Object.values(plan?.services ?? {}).some((service) => service.name === router.id)) {
    // Implementations can invalidate stale readiness evidence after observing a
    // stopped router; this does not run setup or a startup probe.
    yield* Effect.result(router.status);
    return;
  }
  yield* router.revalidateStartup;
});
