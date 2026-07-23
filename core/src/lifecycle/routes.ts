import { Effect } from "effect";

import type { ProxyError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { ProviderError, ProxyServiceShape, RuntimeProviderShape } from "@lando/sdk/services";

import { runAllAndMergeFailures } from "./failure-compensation.ts";
import { proxyUrlsByService } from "./route-urls.ts";

export const applyAppRoutes = (proxy: ProxyServiceShape, plan: AppPlan) =>
  Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })).pipe(
    Effect.zipRight(proxy.applyRoutes(plan.routes, plan.id)),
  );

export const destroyAppliedApp = (provider: RuntimeProviderShape, plan: AppPlan) =>
  provider.destroy({ app: plan.id, plan }, { volumes: true, removeState: true });

export const removeRoutesAndDestroyApp = (
  proxy: ProxyServiceShape,
  provider: RuntimeProviderShape,
  plan: AppPlan,
) =>
  runAllAndMergeFailures<ProxyError | ProviderError, never>([
    proxy.removeRoutes(plan.id),
    destroyAppliedApp(provider, plan),
  ]);

export const destroyAppAndRemoveRoutes = <E, R>(
  providerDestroy: Effect.Effect<void, E, R>,
  proxy: ProxyServiceShape,
  plan: AppPlan,
) => runAllAndMergeFailures<E | ProxyError, R>([providerDestroy, proxy.removeRoutes(plan.id)]);

export const routeUrlsForPlan = (proxy: ProxyServiceShape, plan: AppPlan) =>
  proxy.status.pipe(Effect.map((status) => proxyUrlsByService(plan.routes, status.authorities)));
