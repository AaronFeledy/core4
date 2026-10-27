import { AppPlacementError } from "@lando/sdk/errors";
import type { AppPlan, RouterConfig } from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";
import { Cause, Effect } from "effect";
import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";

export const applyScratchRoutes = Effect.fn("RouterService.applyScratchRoutes")(
  function* (request: {
    readonly plan: AppPlan;
    readonly router?: RouterServiceShape;
    readonly landofileRouter?: RouterConfig;
  }) {
    const { plan, router } = request;
    if (plan.routes.length === 0 || !routerEnabled(plan) || router === undefined) return;
    const defaultDomain = yield* resolveProxyDefaultDomain;
    const resolved = yield* resolveRouterConfigForApp(request.landofileRouter);
    yield* Effect.scoped(router.setup({ defaultDomain, ...resolved }));
    yield* router.applyRoutes(plan.routes, plan.id);
  },
  Effect.asVoid,
  (effect, request) =>
    effect.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = Cause.findErrorOption(cause);
        return error._tag === "Some" && error.value instanceof AppPlacementError
          ? Effect.fail(error.value)
          : Effect.logWarning(
              `Unable to apply routes for scratch app ${String(request.plan.id)}: ${Cause.pretty(cause)}`,
            );
      }),
    ),
);
