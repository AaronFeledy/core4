import { Effect } from "effect";

import type {
  ProxyApplyError,
  ProxyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
} from "@lando/sdk/errors";
import type { AppPlan, ProxyApplyResult, RouterConfig, ServiceName } from "@lando/sdk/schema";
import type { ProviderError, RouterServiceShape, RuntimeProviderShape } from "@lando/sdk/services";

import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";
import { runAllAndMergeFailures } from "./failure-compensation.ts";
import { proxyUrlsByService } from "./route-urls.ts";

export const applyAppRoutes = (
  proxy: RouterServiceShape,
  plan: AppPlan,
  landofileRouter?: RouterConfig,
): Effect.Effect<
  ProxyApplyResult,
  ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch | RouterWatcherError | ProxyApplyError
> =>
  Effect.gen(function* () {
    if (!routerEnabled(plan)) {
      // Best-effort: a disabled plan must not leave previously published hostnames live.
      yield* proxy.removeRoutes(plan.id).pipe(Effect.catchAll(() => Effect.void));
      return { app: plan.id, appliedRoutes: [], authorities: [] };
    }
    const defaultDomain = yield* resolveProxyDefaultDomain;
    const { router, routerPin } = yield* resolveRouterConfigForApp(landofileRouter);
    return yield* Effect.scoped(proxy.setup({ defaultDomain, router, routerPin })).pipe(
      Effect.zipRight(proxy.applyRoutes(plan.routes, plan.id)),
    );
  });

export const teardownAppliedApp = (provider: RuntimeProviderShape, plan: AppPlan) =>
  provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: false });

export const removeRoutesAndDestroyApp = (
  proxy: RouterServiceShape,
  provider: RuntimeProviderShape,
  plan: AppPlan,
) =>
  runAllAndMergeFailures<ProxyError | ProviderError, never>([
    proxy.removeRoutes(plan.id),
    teardownAppliedApp(provider, plan),
  ]);

export const destroyAppAndRemoveRoutes = <E, R>(
  providerDestroy: Effect.Effect<void, E, R>,
  proxy: RouterServiceShape,
  plan: AppPlan,
) => runAllAndMergeFailures<E | ProxyError, R>([providerDestroy, proxy.removeRoutes(plan.id)]);

export const routeUrlsForPlan = (proxy: RouterServiceShape, plan: AppPlan) =>
  routerEnabled(plan)
    ? proxy.status.pipe(Effect.map((status) => proxyUrlsByService(plan.routes, status.authorities)))
    : Effect.succeed<ReadonlyMap<ServiceName, ReadonlyArray<string>>>(new Map());
