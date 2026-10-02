import { Effect } from "effect";

import {
  type AppPlan,
  DEFAULT_ROUTER_HTTPS_PORTS,
  DEFAULT_ROUTER_HTTP_PORTS,
  type RouterConfig,
} from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

const DEFAULT_BIND_ADDRESS = "127.0.0.1";
const DEFAULT_ENABLED = true;

type MergedRouterConfig = {
  readonly enabled: boolean;
  readonly httpPorts: readonly [number, ...number[]];
  readonly httpsPorts: readonly [number, ...number[]];
  readonly bindAddress: string;
};

export type RouterPin = {
  readonly httpPort?: number;
  readonly httpsPort?: number;
};

const overlayPorts = (
  prior: readonly [number, ...number[]],
  preferred: number | undefined,
  fallbacks: readonly number[] | undefined,
): readonly [number, ...number[]] => {
  const nextPreferred = preferred ?? prior[0];
  const rest = fallbacks !== undefined ? fallbacks : prior.slice(1);
  return [nextPreferred, ...rest];
};

const overlayRouter = (prior: MergedRouterConfig, overlay: RouterConfig | undefined): MergedRouterConfig => {
  if (overlay === undefined) return prior;
  return {
    enabled: overlay.enabled ?? prior.enabled,
    httpPorts: overlayPorts(prior.httpPorts, overlay.httpPort, overlay.httpFallbacks),
    httpsPorts: overlayPorts(prior.httpsPorts, overlay.httpsPort, overlay.httpsFallbacks),
    bindAddress: overlay.bindAddress ?? prior.bindAddress,
  };
};

const COMPILED_DEFAULTS: MergedRouterConfig = {
  enabled: DEFAULT_ENABLED,
  httpPorts: DEFAULT_ROUTER_HTTP_PORTS,
  httpsPorts: DEFAULT_ROUTER_HTTPS_PORTS,
  bindAddress: DEFAULT_BIND_ADDRESS,
};

export const mergeRouterConfig = (
  globalRouter: RouterConfig | undefined,
  landofileRouter: RouterConfig | undefined,
): MergedRouterConfig => overlayRouter(overlayRouter(COMPILED_DEFAULTS, globalRouter), landofileRouter);

/**
 * Router enablement under normal precedence: the compiled default, then the
 * user's global config, then the app's Landofile. The planner resolves this
 * once and records the answer on the plan so every later consumer reads one
 * decision instead of re-deriving it.
 */
export const routerEnabledFrom = (
  globalRouter: RouterConfig | undefined,
  landofileRouter: RouterConfig | undefined,
): boolean => mergeRouterConfig(globalRouter, landofileRouter).enabled;

/**
 * Reads the planner's recorded answer. Every consumer that starts, publishes,
 * or hands out a shared-router hostname asks this instead of re-resolving
 * precedence; plans persisted before the field existed default to enabled.
 */
export const routerEnabled = (plan: Pick<AppPlan, "router">): boolean => plan.router?.enabled ?? true;

export const extractRouterPins = (landofileRouter: RouterConfig | undefined): RouterPin => ({
  ...(landofileRouter?.httpPort === undefined ? {} : { httpPort: landofileRouter.httpPort }),
  ...(landofileRouter?.httpsPort === undefined ? {} : { httpsPort: landofileRouter.httpsPort }),
});

const toSetupRouter = (
  merged: MergedRouterConfig,
  globalRouter: RouterConfig | undefined,
  landofileRouter: RouterConfig | undefined,
): RouterConfig => ({
  enabled: merged.enabled,
  bindAddress: merged.bindAddress,
  ...(globalRouter?.httpPort === undefined && landofileRouter?.httpPort === undefined
    ? {}
    : { httpPort: merged.httpPorts[0] }),
  ...(globalRouter?.httpsPort === undefined && landofileRouter?.httpsPort === undefined
    ? {}
    : { httpsPort: merged.httpsPorts[0] }),
  ...(globalRouter?.httpFallbacks === undefined && landofileRouter?.httpFallbacks === undefined
    ? {}
    : { httpFallbacks: merged.httpPorts.slice(1) }),
  ...(globalRouter?.httpsFallbacks === undefined && landofileRouter?.httpsFallbacks === undefined
    ? {}
    : { httpsFallbacks: merged.httpsPorts.slice(1) }),
});

const resolveGlobalRouter: Effect.Effect<RouterConfig | undefined> = Effect.gen(function* () {
  const configOpt = yield* Effect.serviceOption(ConfigService);
  if (configOpt._tag === "None") return undefined;
  return yield* configOpt.value.load.pipe(
    Effect.map((config) => config.router),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
});

export const resolveRouterConfigForApp = (
  landofileRouter?: RouterConfig,
): Effect.Effect<{
  readonly router: RouterConfig;
  readonly routerPin: RouterPin;
  readonly enabled: boolean;
}> =>
  Effect.gen(function* () {
    const globalRouter = yield* resolveGlobalRouter;
    const merged = mergeRouterConfig(globalRouter, landofileRouter);
    return {
      router: toSetupRouter(merged, globalRouter, landofileRouter),
      routerPin: extractRouterPins(landofileRouter),
      enabled: merged.enabled,
    };
  });
