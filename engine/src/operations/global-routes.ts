import { Effect } from "effect";

import type { ProxyApplyError } from "@lando/sdk/errors";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { ProviderError, RouterServiceShape, RuntimeProviderShape } from "@lando/sdk/services";

import { routerEnabled } from "../config/router-config.ts";
import { appliedProxyUrlsByService } from "../lifecycle/route-urls.ts";

/**
 * Replace the global route file with routes of started services and active owned siblings.
 */
export const publishGlobalRoutes = Effect.fn("GlobalRoutes.publish")(function* (
  router: RouterServiceShape,
  provider: Pick<RuntimeProviderShape, "list">,
  plan: AppPlan,
  outcome: {
    readonly started: ReadonlySet<string>;
    readonly failed: ReadonlySet<string>;
  },
): Effect.fn.Return<ReadonlyMap<ServiceName, ReadonlyArray<string>>, ProxyApplyError | ProviderError> {
  if (plan.routes.length === 0 || !routerEnabled(plan)) {
    // Best-effort: a route-free or router-disabled plan must not leave previously published hostnames live.
    yield* router.removeRoutes(plan.id).pipe(Effect.catch(() => Effect.void));
    return new Map<ServiceName, ReadonlyArray<string>>();
  }
  const { started, failed } = outcome;
  const observed = plan.routes.some((route) => !started.has(route.service) && !failed.has(route.service))
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
  const routes = plan.routes.filter(
    (route) => !failed.has(route.service) && (started.has(route.service) || active.has(route.service)),
  );
  return appliedProxyUrlsByService(yield* router.applyRoutes(routes, plan.id));
});
