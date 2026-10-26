import { Effect } from "effect";

import type { ProxyApplyError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { ProviderError, RouterServiceShape, RuntimeProviderShape } from "@lando/sdk/services";

import { routerEnabled } from "../config/router-config.ts";

/**
 * Replace the global route file only after all selected groups succeed, retaining active owned siblings.
 */
export const publishGlobalRoutes = Effect.fn("GlobalRoutes.publish")(function* (
  router: RouterServiceShape,
  provider: Pick<RuntimeProviderShape, "list">,
  plan: AppPlan,
  outcome: {
    readonly started: ReadonlySet<string>;
    readonly failed: ReadonlySet<string>;
  },
): Effect.fn.Return<void, ProxyApplyError | ProviderError> {
  if (outcome.failed.size > 0) return;
  if (plan.routes.length === 0 || !routerEnabled(plan)) {
    // Best-effort: a route-free or router-disabled plan must not leave previously published hostnames live.
    yield* router.removeRoutes(plan.id).pipe(Effect.catch(() => Effect.void));
    return;
  }
  const { started } = outcome;
  const observed = plan.routes.some((route) => !started.has(route.service))
    ? yield* provider.list({ app: plan.id })
    : [];
  const active = new Set(
    observed
      .filter(
        (service) =>
          service.app === plan.id &&
          service.appRoot === plan.root &&
          service.providerId === plan.provider &&
          (service.status === "running" || service.status === "paused" || service.status === "restarting"),
      )
      .map((service) => service.service),
  );
  const routes = plan.routes.filter((route) => started.has(route.service) || active.has(route.service));
  yield* router.applyRoutes(routes, plan.id);
});
