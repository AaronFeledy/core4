import { Effect } from "effect";

import type { RouterConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

const DEFAULT_HTTP_PORTS = [80, 8080, 8000, 8888, 8008, 38080] as const;
const DEFAULT_HTTPS_PORTS = [443, 8443, 4443, 4433, 4444, 444, 38443] as const;
const DEFAULT_BIND_ADDRESS = "127.0.0.1";

type MergedRouterConfig = {
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
    httpPorts: overlayPorts(prior.httpPorts, overlay.httpPort, overlay.httpFallbacks),
    httpsPorts: overlayPorts(prior.httpsPorts, overlay.httpsPort, overlay.httpsFallbacks),
    bindAddress: overlay.bindAddress ?? prior.bindAddress,
  };
};

const COMPILED_DEFAULTS: MergedRouterConfig = {
  httpPorts: DEFAULT_HTTP_PORTS,
  httpsPorts: DEFAULT_HTTPS_PORTS,
  bindAddress: DEFAULT_BIND_ADDRESS,
};

export const mergeRouterConfig = (
  globalRouter: RouterConfig | undefined,
  landofileRouter: RouterConfig | undefined,
): MergedRouterConfig => overlayRouter(overlayRouter(COMPILED_DEFAULTS, globalRouter), landofileRouter);

export const extractRouterPins = (landofileRouter: RouterConfig | undefined): RouterPin => ({
  ...(landofileRouter?.httpPort === undefined ? {} : { httpPort: landofileRouter.httpPort }),
  ...(landofileRouter?.httpsPort === undefined ? {} : { httpsPort: landofileRouter.httpsPort }),
});

const toSetupRouter = (merged: MergedRouterConfig): RouterConfig => ({
  bindAddress: merged.bindAddress,
  httpPort: merged.httpPorts[0],
  httpsPort: merged.httpsPorts[0],
  httpFallbacks: merged.httpPorts.slice(1),
  httpsFallbacks: merged.httpsPorts.slice(1),
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
}> =>
  Effect.gen(function* () {
    const globalRouter = yield* resolveGlobalRouter;
    return {
      router: toSetupRouter(mergeRouterConfig(globalRouter, landofileRouter)),
      routerPin: extractRouterPins(landofileRouter),
    };
  });
