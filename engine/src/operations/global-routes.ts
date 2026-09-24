import { Effect } from "effect";

import type {
  ProxyApplyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
} from "@lando/sdk/errors";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";

import { appliedProxyUrlsByService } from "../lifecycle/route-urls.ts";
import { applyAppRoutes } from "../lifecycle/routes.ts";

/**
 * The global app owns one durable route file. A selected service start must
 * write the full declared route set so it does not erase another global route.
 */
export const applyGlobalRoutesForSelectedServices = (
  router: RouterServiceShape,
  plan: AppPlan,
  selectedNames: ReadonlySet<string>,
): Effect.Effect<
  ReadonlyMap<ServiceName, ReadonlyArray<string>>,
  ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch | RouterWatcherError | ProxyApplyError
> =>
  plan.routes.some((route) => selectedNames.has(String(route.service)))
    ? applyAppRoutes(router, plan).pipe(Effect.map(appliedProxyUrlsByService))
    : Effect.succeed(new Map<ServiceName, ReadonlyArray<string>>());
