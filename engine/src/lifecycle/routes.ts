import type {
  AppPlacementError,
  ProxyApplyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan, ProxyApplyResult, RouterConfig } from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";
import type { ProgressEmitter } from "@lando/sdk/task-progress";
import { DateTime, Effect, Result } from "effect";

import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";
import { verifyGlobalConsumerAdmission } from "../operations/global-consumer-lease.ts";
import { unavailableRouterReason } from "../subsystems/proxy/api.ts";
import { routeOwnerFromPlan } from "./route-owner.ts";

export const applyAppRoutes = Effect.fn("Lifecycle.applyAppRoutes")(function* (
  proxy: RouterServiceShape,
  plan: AppPlan,
  events: ProgressEmitter,
  landofileRouter?: RouterConfig,
): Effect.fn.Return<
  ProxyApplyResult,
  | AppPlacementError
  | ProxySetupError
  | RouterPortsExhausted
  | RouterPortPinMismatch
  | RouterWatcherError
  | ProxyApplyError
  | Effect.Error<typeof verifyGlobalConsumerAdmission>
> {
  if (!routerEnabled(plan) || plan.routes.length === 0) {
    // Best-effort: a disabled or route-free plan must withdraw previously published hostnames.
    const withdrawn = yield* Effect.result(proxy.removeRoutes(routeOwnerFromPlan(plan)));
    // A host with no router published nothing, so only a router that tried and failed is worth a warning.
    if (Result.isFailure(withdrawn) && withdrawn.failure !== unavailableRouterReason(proxy)) {
      yield* events
        .publish(
          MessageWarnEvent.make({
            body: `Routes that ${plan.name} published earlier were not withdrawn, so its old URLs may still resolve. ${withdrawn.failure.message} ${withdrawn.failure.remediation}`,
            timestamp: DateTime.nowUnsafe(),
          }),
        )
        .pipe(Effect.ignore);
    }
    return { app: plan.id, appliedRoutes: [], authorities: [] };
  }
  const defaultDomain = yield* resolveProxyDefaultDomain;
  const { router, routerPin } = yield* resolveRouterConfigForApp(landofileRouter);
  return yield* Effect.scoped(proxy.setup({ defaultDomain, router, routerPin })).pipe(
    Effect.andThen(verifyGlobalConsumerAdmission),
    Effect.andThen(proxy.applyRoutes(plan.routes, routeOwnerFromPlan(plan))),
  );
});
