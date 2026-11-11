import { DateTime, Effect, Option } from "effect";

import type {
  AppPlacementError,
  ProxyApplyError,
  ProxyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan, AppRouteOwner, ProxyApplyResult, RouterConfig } from "@lando/sdk/schema";
import { EventService, RouterService, type RouterServiceShape } from "@lando/sdk/services";

import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";
import { verifyGlobalConsumerAdmission } from "../operations/global-consumer-lease.ts";
import { UNAVAILABLE_ID } from "../subsystems/unavailable.ts";
import { routeOwnerFromPlan } from "./route-owner.ts";

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
    yield* withdrawOwnerRoutes(routeOwnerFromPlan(plan), { onFailure: "ignore" }).pipe(
      Effect.provideService(RouterService, proxy),
    );
    return { app: plan.id, appliedRoutes: [], authorities: [] };
  }
  const defaultDomain = yield* resolveProxyDefaultDomain;
  const { router, routerPin } = yield* resolveRouterConfigForApp(landofileRouter);
  return yield* Effect.scoped(proxy.setup({ defaultDomain, router, routerPin })).pipe(
    Effect.andThen(verifyGlobalConsumerAdmission),
    Effect.andThen(proxy.applyRoutes(plan.routes, routeOwnerFromPlan(plan))),
  );
});

export type WithdrawOwnerRoutesOptions = {
  /** `"fail"` (default) surfaces router failures; `"ignore"` makes withdrawal best-effort. */
  readonly onFailure?: "fail" | "ignore";
};

const withdrawOwnerRoutesWith = Effect.fn("Lifecycle.withdrawOwnerRoutes")(function* (
  owner: AppRouteOwner,
  onFailure: "fail" | "ignore",
): Effect.fn.Return<void, ProxyError> {
  const router = yield* Effect.serviceOption(RouterService);
  if (Option.isSome(router) && router.value.id !== UNAVAILABLE_ID) {
    const removal = router.value.removeRoutes(owner);
    return yield* onFailure === "ignore" ? removal.pipe(Effect.catch(() => Effect.void)) : removal;
  }
  // Best-effort cleanup without a router has nothing to report: no definition could have been removed.
  if (onFailure === "ignore") return;
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isNone(events)) return;
  yield* events.value
    .publish(
      MessageWarnEvent.make({
        body: `Proxy service is unavailable; published routes for ${owner.id} were left in place.`,
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    .pipe(Effect.ignore);
});

/**
 * Withdraw one owner's published routes from the contextual `RouterService` without building or
 * starting a router. With no selectable router the definition stays on disk and the caller
 * succeeds after a warning; the unavailable router's `removeRoutes` is never called, so pending
 * global route cleanup is not falsely cleared. `onFailure: "ignore"` swallows router failures for
 * best-effort cleanup inside publication paths.
 */
export function withdrawOwnerRoutes(
  owner: AppRouteOwner,
  options: { readonly onFailure: "ignore" },
): Effect.Effect<void>;
export function withdrawOwnerRoutes(
  owner: AppRouteOwner,
  options?: { readonly onFailure?: "fail" },
): Effect.Effect<void, ProxyError>;
export function withdrawOwnerRoutes(
  owner: AppRouteOwner,
  options: WithdrawOwnerRoutesOptions = {},
): Effect.Effect<void, ProxyError> {
  return withdrawOwnerRoutesWith(owner, options.onFailure ?? "fail");
}
