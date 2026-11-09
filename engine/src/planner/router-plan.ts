import { RouteProviderMismatchError } from "@lando/sdk/errors";
import type { HostPlatform, PluginManifest, ProviderId, RouterServiceContribution } from "@lando/sdk/schema";
import { Effect, Option } from "effect";
import { selectRouterContribution } from "../subsystems/proxy/selection.ts";

/**
 * The router a plan's routes would publish through, chosen from manifests and config without
 * loading the router. When no router can be selected the plan records none and planning still
 * succeeds; the runtime router registry reports that problem when routes are published, so
 * commands that only plan (info, config, lint) keep working.
 */
export interface PlanRouter {
  readonly selected: RouterServiceContribution | undefined;
  /** Fails when routes would publish through a router on a different provider than the app. */
  readonly requireRoutable: (
    routeCount: number,
    provider: ProviderId,
    hostProvider: ProviderId,
  ) => Effect.Effect<void, RouteProviderMismatchError>;
  /** Global services the selected router needs for this many routes. */
  readonly globalServices: (routeCount: number) => ReadonlyArray<string>;
  /** The plan's `router` field: the selected id is recorded only for routed plans. */
  readonly field: (routeCount: number) => { readonly enabled: boolean; readonly id?: string };
}

export const resolvePlanRouter = Effect.fnUntraced(function* (options: {
  readonly enabled: boolean;
  readonly manifests: ReadonlyArray<PluginManifest>;
  readonly configured: string | undefined;
  readonly platform: HostPlatform;
}) {
  const selection = options.enabled
    ? yield* selectRouterContribution({
        contributions: options.manifests.flatMap((manifest) => manifest.contributes?.routerServices ?? []),
        configured: options.configured,
        platform: options.platform,
      }).pipe(Effect.option)
    : Option.none();
  const selected = Option.getOrUndefined(selection);
  const routed = (routeCount: number) => options.enabled && routeCount > 0;
  return {
    selected,
    requireRoutable: (routeCount, provider, hostProvider) =>
      routed(routeCount) && provider !== hostProvider
        ? Effect.fail(
            new RouteProviderMismatchError({
              message: `App provider ${provider} differs from host router provider ${hostProvider}.`,
              providerId: provider,
              hostProviderId: hostProvider,
              remediation: `Run lando setup --provider=${provider} to move the global app and router there; remove provider: from the Landofile so the app follows the host provider; or set router.enabled: false and use published host ports.`,
            }),
          )
        : Effect.void,
    globalServices: (routeCount) => (routed(routeCount) ? (selected?.requires?.globalServices ?? []) : []),
    field: (routeCount) => ({
      enabled: options.enabled,
      ...(selected === undefined || routeCount === 0 ? {} : { id: selected.id }),
    }),
  } satisfies PlanRouter;
});
