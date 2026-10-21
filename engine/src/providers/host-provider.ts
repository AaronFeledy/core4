import { ProviderConfigError } from "@lando/sdk/errors";
import type { ProviderId } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Context, Effect } from "effect";
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
export const hostProviderSelectionFrom = (configured: ProviderId | null | undefined) =>
  Effect.map(
    HostProviderOverride,
    (override): HostProviderSelection =>
      override !== undefined
        ? { providerId: override, source: "setup" }
        : resolveHostProviderSelection({
            env: readProviderEnvVar(process.env),
            config: configured ?? undefined,
          }),
  );

export const hostProviderIdFrom = (configured: ProviderId | null | undefined) =>
  Effect.map(hostProviderSelectionFrom(configured), (selection) => selection.providerId);

export const hostProviderSelection = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ConfigService);
  const configured =
    service._tag === "Some"
      ? yield* service.value.get("defaultProviderId").pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConfigError({
                providerId: "unknown",
                operation: "select",
                message: "Unable to read the host runtime provider configuration.",
                cause,
              }),
          ),
        )
      : undefined;
  return yield* hostProviderSelectionFrom(configured);
});

export const hostProviderId = Effect.map(hostProviderSelection, (selection) => selection.providerId);
