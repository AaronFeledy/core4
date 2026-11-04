import { Effect } from "effect";

import type {
  AppPlacementError,
  ProxyApplyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
} from "@lando/sdk/errors";
import type { AppPlan, ProxyApplyResult, RouterConfig } from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";

import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";
import { verifyGlobalConsumerAdmission } from "../operations/global-consumer-lease.ts";

export const applyAppRoutes = Effect.fn("Lifecycle.applyAppRoutes")(function* (
  proxy: RouterServiceShape,
  plan: AppPlan,
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
    yield* proxy.removeRoutes(plan.id).pipe(Effect.catch(() => Effect.void));
    return { app: plan.id, appliedRoutes: [], authorities: [] };
  }
  const defaultDomain = yield* resolveProxyDefaultDomain;
  const { router, routerPin } = yield* resolveRouterConfigForApp(landofileRouter);
  return yield* Effect.scoped(proxy.setup({ defaultDomain, router, routerPin })).pipe(
    Effect.andThen(verifyGlobalConsumerAdmission),
    Effect.andThen(proxy.applyRoutes(plan.routes, plan.id)),
  );
});
