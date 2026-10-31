import { Context, Effect, Option } from "effect";

import { type ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import { PathsService, PluginRegistry } from "@lando/sdk/services";

import { GlobalPluginManifests } from "../plugins/global-manifests.ts";
import { hostProviderId } from "../providers/host-provider.ts";
import { bundledFirstGlobalServiceLoader } from "../services/bundled-global-service-loader.ts";
import { resolveGlobalServices } from "../services/global-services.ts";
import { type GlobalPolicy, readGlobalPolicy } from "./enablement.ts";

export {
  GlobalContributionStateSchema,
  type GlobalContributionState,
  type GlobalResolution,
  assertGlobalResolution,
  assertEffectiveGlobalServices,
  resolveEffectiveGlobalServices,
  projectEffectiveGlobalResolution,
  type EffectiveGlobalServices,
} from "../services/global-services.ts";

const RuntimeGlobalCapabilities = Context.Reference<
  | {
      readonly providerId: string;
      readonly capabilities: ProviderCapabilities;
    }
  | undefined
>("@lando/engine/RuntimeGlobalCapabilities", { defaultValue: () => undefined });

/** A runtime that already acquired capabilities supplies them to the same read-only resolver. */
export const withGlobalResolutionCapabilities = <A, E, R>(
  providerId: string,
  capabilities: ProviderCapabilities,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  body.pipe(Effect.provideService(RuntimeGlobalCapabilities, { providerId, capabilities }));

export const captureGlobalResolution = Effect.fn("GlobalApp.captureResolution")(function* (
  options: {
    readonly policy?: GlobalPolicy;
    readonly providerCapabilities?: ProviderCapabilities;
    readonly providerId?: string;
  } = {},
) {
  const registry = yield* PluginRegistry;
  const paths = yield* PathsService;
  const globalManifests = yield* Effect.serviceOption(GlobalPluginManifests);
  const manifests = Option.isSome(globalManifests) ? yield* globalManifests.value.list : yield* registry.list;
  const policy = options.policy ?? (yield* readGlobalPolicy());
  const providerId = options.providerId ?? (yield* hostProviderId);
  const runtime = yield* RuntimeGlobalCapabilities;
  const runtimeCapabilities =
    options.providerCapabilities ?? (runtime?.providerId === providerId ? runtime.capabilities : undefined);
  const capabilities =
    runtimeCapabilities ??
    registry.declaredProviderCapabilities?.(ProviderId.make(providerId), paths.platform);
  return {
    manifests,
    policy,
    providerId,
    ...(capabilities === undefined
      ? {}
      : {
          providerCapabilities: capabilities,
          capabilitySource: runtimeCapabilities === undefined ? ("declared" as const) : ("runtime" as const),
        }),
    loadServiceConfig: bundledFirstGlobalServiceLoader.load,
  };
});

export const readGlobalResolution = Effect.fn("GlobalApp.readResolution")(function* (
  options: Parameters<typeof captureGlobalResolution>[0] = {},
) {
  return yield* resolveGlobalServices(yield* captureGlobalResolution(options));
});
