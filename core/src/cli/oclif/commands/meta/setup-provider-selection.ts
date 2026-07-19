/**
 * `meta:setup` provider selection and the synthetic setup plan.
 *
 * A system runtime (`docker`/`podman`) requires an existing host install, so
 * `systemRuntimeUnavailableError` is the remediation-bearing failure when it is
 * absent. `maybeSelectSetupProvider` only prompts when the provider was the
 * capability default and the run is interactive; otherwise it honors the
 * resolved selection. `setupProviderPlan` is the minimal plan used to drive
 * provider selection from the registry.
 */
import { DateTime } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

import {
  type InteractionPrompter,
  makePromiseInteractionPrompter,
} from "../../../../interaction/prompter.ts";
import { makeInteractionService } from "../../../../interaction/service.ts";
import type { ProviderSelectionResolution } from "../../../../providers/precedence.ts";

export const SYSTEM_RUNTIME_PROVIDERS: Record<string, string> = {
  docker: "Docker",
  podman: "Podman",
};

export const systemRuntimeUnavailableError = (providerId: string): ProviderUnavailableError => {
  const runtimeName = SYSTEM_RUNTIME_PROVIDERS[providerId] ?? providerId;
  return new ProviderUnavailableError({
    providerId,
    operation: "setup",
    message: `\`lando setup --provider=${providerId}\` requires an existing ${runtimeName} installation, but ${runtimeName} was not detected on this host.`,
    remediation: `Install ${runtimeName} and make sure it is running, then rerun \`lando setup --provider=${providerId}\`. To use the bundled Lando-managed runtime instead, run \`lando setup\` (the default) or \`lando setup --provider=lando\`.`,
  });
};

export const setupProviderPlan = (provider: ProviderId): AppPlan => ({
  id: AppId.make("setup"),
  name: "setup",
  slug: "setup",
  root: AbsolutePath.make("/"),
  provider,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
    source: "meta:setup",
    runtime: 4,
  },
  extensions: {},
});

const SETUP_PROVIDER_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "lando", label: "Lando-managed runtime (bundled, recommended)" },
  { value: "docker", label: "Docker (existing installation required)" },
  { value: "podman", label: "Podman (existing installation required)" },
];

export const maybeSelectSetupProvider = async (params: {
  readonly resolution: ProviderSelectionResolution;
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly skipProvider: boolean;
  readonly interaction?: InteractionPrompter;
}): Promise<ProviderId> => {
  const fallback = params.resolution.providerId;
  if (params.resolution.source !== "default") return fallback;
  if (params.yes || params.nonInteractive || params.skipProvider) return fallback;
  const interaction = params.interaction ?? makePromiseInteractionPrompter(makeInteractionService());
  try {
    const chosen = await interaction.select({
      message: "Select the container runtime provider for Lando",
      name: "provider",
      default: String(fallback),
      choices: SETUP_PROVIDER_CHOICES,
      yes: params.yes,
      ...(params.nonInteractive ? { interactive: false } : {}),
    });
    return chosen === "" ? fallback : ProviderId.make(chosen);
  } catch {
    return fallback;
  }
};
