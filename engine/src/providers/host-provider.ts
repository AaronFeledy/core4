import type { ProviderId } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Context, Effect, Option } from "effect";
import { GlobalConfigSources } from "../services/config.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "./precedence.ts";

/** Which input chose the host provider; `setup` is the scoped override setup installs. */
export type HostProviderSource = "setup" | "env" | "config" | "default";

export interface HostProviderSelection {
  readonly providerId: ProviderId;
  readonly source: HostProviderSource;
}

/** The provider a host-level command resolves with no app: environment, then configuration, then default. */
export const resolveHostProviderSelection = (input: {
  readonly env?: ProviderId | undefined;
  readonly config?: ProviderId | undefined;
}): HostProviderSelection => {
  const { providerId, source } = resolveProviderSelection({
    ...input,
    capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
  });
  return { providerId, source: source === "env" || source === "config" ? source : "default" };
};

/** Scoped host provider set by setup so its steps target the provider it just prepared. */
export const HostProviderOverride = Context.Reference<ProviderId | undefined>(
  "@lando/engine/HostProviderOverride",
  {
    defaultValue: () => undefined,
  },
);

/** Host provider selection for an already-loaded `defaultProviderId`; the override still wins. */
export const hostProviderSelectionFrom = Effect.fnUntraced(function* (
  configured: ProviderId | null | undefined,
) {
  const override = yield* HostProviderOverride;
  if (override !== undefined)
    return { providerId: override, source: "setup" } satisfies HostProviderSelection;
  const captured = yield* Effect.serviceOption(GlobalConfigSources);
  return resolveHostProviderSelection({
    env: readProviderEnvVar(
      Option.isNone(captured) ? process.env : captured.value.sources.env ? captured.value.env : {},
    ),
    config: configured ?? undefined,
  });
});

export const hostProviderIdFrom = (configured: ProviderId | null | undefined) =>
  Effect.map(hostProviderSelectionFrom(configured), (selection) => selection.providerId);

export const hostProviderSelection = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ConfigService);
  const configured = service._tag === "Some" ? yield* service.value.get("defaultProviderId") : undefined;
  return yield* hostProviderSelectionFrom(configured);
});

export const hostProviderId = Effect.map(hostProviderSelection, (selection) => selection.providerId);
