import { ownsAppliedGlobalService } from "@lando/container-runtime/applied-global-service";
import { mapFailures } from "@lando/sdk/command-result";
import { type GlobalAppError, ProxyApplyError } from "@lando/sdk/errors";
import { type AppPlan, isActiveRunStatus } from "@lando/sdk/schema";
import type { ProviderError, RouterServiceShape, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { routerEnabled } from "../config/router-config.ts";
import { withGlobalRoutePublication } from "../global-app/activation-scope.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import { unavailableRouterReason } from "../subsystems/proxy/api.ts";

/**
 * Withdraw the global app's route definition without router setup. Only the unavailable router's own
 * reason (no router installed, so nothing was published) is silent; an installed router's failure
 * fails the command while the applied services stay up.
 */
export const withdrawGlobalRoutes = Effect.fn("GlobalRoutes.withdraw")(function* (
  router: RouterServiceShape,
  plan: AppPlan,
) {
  const reason = unavailableRouterReason(router);
  return yield* router.removeRoutes(routeOwnerFromPlan(plan)).pipe(
    Effect.catchIf(
      (error) => error === reason,
      () => Effect.void,
    ),
    mapFailures(
      (error) =>
        new ProxyApplyError({
          proxyId: error.proxyId,
          app: String(plan.id),
          message: `Routes the global app published earlier could not be withdrawn, so its old URLs may still resolve. Its services remain applied. ${error.message}`,
          remediation: `${error.remediation} Inspect the global app with \`lando global:info\`, fix the router problem, then run \`lando global:start\` again.`,
          cause: error,
        }),
    ),
  );
});

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
  beforeRoutes?: Effect.Effect<void, GlobalAppError>,
): Effect.fn.Return<void, ProxyApplyError | ProviderError | GlobalAppError> {
  if (outcome.failed.size > 0) return;
  const withdraw = withdrawGlobalRoutes(router, plan);
  return yield* withGlobalRoutePublication(
    Effect.gen(function* () {
      if (plan.routes.length === 0 || !routerEnabled(plan)) {
        yield* beforeRoutes ?? Effect.void;
        // A route-free or router-disabled plan must not leave previously published hostnames live.
        yield* withdraw;
        return;
      }
      const { started } = outcome;
      const observed = plan.routes.some((route) => !started.has(route.service))
        ? yield* provider.list({ app: plan.id })
        : [];
      const active = new Set(
        observed
          .filter((service) => ownsAppliedGlobalService(plan, service) && isActiveRunStatus(service.status))
          .map((service) => service.service),
      );
      const routes = plan.routes.filter((route) => started.has(route.service) || active.has(route.service));
      yield* beforeRoutes ?? Effect.void;
      if (routes.length === 0) {
        // An empty selection removes the definition; it never publishes an empty route set.
        yield* withdraw;
        return;
      }
      yield* router.applyRoutes(routes, routeOwnerFromPlan(plan));
    }),
  );
});
