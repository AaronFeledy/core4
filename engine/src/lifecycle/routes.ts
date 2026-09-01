import { Effect } from "effect";

import type {
  ProxyApplyError,
  ProxyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
} from "@lando/sdk/errors";
import type { AppPlan, ProxyApplyResult, RouterConfig } from "@lando/sdk/schema";
import type { ProviderError, RouterServiceShape, RuntimeProviderShape } from "@lando/sdk/services";

import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp } from "../config/router-config.ts";
import { runAllAndMergeFailures } from "./failure-compensation.ts";
import { proxyUrlsByService } from "./route-urls.ts";

export const applyAppRoutes = (
  proxy: RouterServiceShape,
  plan: AppPlan,
  landofileRouter?: RouterConfig,
): Effect.Effect<
  ProxyApplyResult,
  ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch | ProxyApplyError
> =>
  Effect.gen(function* () {
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
  proxy.status.pipe(Effect.map((status) => proxyUrlsByService(plan.routes, status.authorities)));
