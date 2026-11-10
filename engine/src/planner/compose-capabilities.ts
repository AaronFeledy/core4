import { type Context, Effect } from "effect";

import { CapabilityError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type HostPlatform,
  type PluginManifest,
  type ProviderCapabilities,
  ProviderId,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";

import { collectComposeKnobs, findUnsupportedComposeKnob } from "../services/compose-knobs.ts";
import {
  collectComposePreservedPaths,
  findUnsupportedComposePreservedPath,
} from "../services/compose-preserved-paths.ts";
import {
  collectComposeProjectFields,
  findUnsupportedComposeProjectField,
} from "../services/compose-project-fields.ts";
import {
  collectComposeServiceFields,
  findUnsupportedComposeServiceField,
} from "../services/compose-service-fields.ts";
import { contributionId } from "./service-types.ts";

type ComposeServices = Readonly<Record<string, Pick<ServicePlan, "name" | "extensions">>>;

export interface ProviderAlternative {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
}

/** The selected provider plus every installed provider's offline capability declaration. */
export interface CapabilityContext {
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly alternatives: ReadonlyArray<ProviderAlternative>;
}

/** Installed providers that declare their capabilities offline for this host. */
export const providerAlternatives = (
  registry: Pick<Context.Service.Shape<typeof PluginRegistry>, "declaredProviderCapabilities">,
  manifests: ReadonlyArray<PluginManifest>,
  platform: HostPlatform,
): ReadonlyArray<ProviderAlternative> => {
  const ids = new Set(
    manifests.flatMap((manifest) => (manifest.contributes?.providers ?? []).map(contributionId)),
  );
  return [...ids].sort().flatMap((raw) => {
    const id = ProviderId.make(raw);
    const capabilities = registry.declaredProviderCapabilities?.(id, platform);
    return capabilities === undefined ? [] : [{ id, capabilities }];
  });
};

const joinAlternatives = (actions: ReadonlyArray<string>): string =>
  actions.length <= 2 ? actions.join(", or ") : `${actions.slice(0, -1).join(", ")}, or ${actions.at(-1)}`;

/**
 * Remediation for an unsupported Compose key that names only actions that exist: remove the key,
 * switch to an installed provider that declares support, or use a provider extension namespace the
 * selected provider accepts.
 */
const capabilityRemediation = (
  context: CapabilityContext,
  removal: string,
  supports: (capabilities: ProviderCapabilities) => boolean,
): string => {
  const supporting = context.alternatives.filter(
    (alternative) => alternative.id !== context.provider && supports(alternative.capabilities),
  );
  const namespaces = context.capabilities.providerExtensions;
  const actions = [
    removal,
    ...(supporting.length === 0
      ? []
      : [
          `use a provider that supports it: ${supporting
            .map(({ id }) => `${id} (\`lando setup --provider=${id}\`)`)
            .join(", ")}`,
        ]),
    ...(namespaces.length === 0
      ? []
      : [`move the intent under ${namespaces.map((namespace) => `providers.${namespace}`).join(" or ")}`]),
  ];
  return `${joinAlternatives(actions)}.`;
};

export const missingCapability = (
  providerId: ProviderId,
  serviceName: string,
  feature: string,
  capability: keyof ProviderCapabilities,
  remediation: string,
) =>
  new CapabilityError({
    message: `Service ${serviceName} requires provider capability ${String(capability)} for ${feature}.`,
    service: serviceName,
    feature,
    capability: String(capability),
    providerId: String(providerId),
    remediation,
  });

export const assertAuthoredNetworksSupported = (
  providerId: ProviderId,
  capabilities: ProviderCapabilities,
  networking: AppPlan["networking"],
): Effect.Effect<void, CapabilityError> => {
  if (
    capabilities.authoredNetworks === true ||
    ((networking?.authoredNetworks?.length ?? 0) === 0 && networking?.perAppBridge?.aliases === undefined)
  )
    return Effect.void;
  return Effect.fail(
    new CapabilityError({
      message: `Provider ${providerId} does not support authored networks or network aliases.`,
      feature: "authored networks",
      capability: "authoredNetworks",
      providerId: String(providerId),
      key: "networks",
      remediation:
        "Remove authored networks and network aliases, or choose a provider that supports authoredNetworks.",
    }),
  );
};

export const assertComposeKnobsSupported = (
  context: CapabilityContext,
  services: ComposeServices,
): Effect.Effect<void, CapabilityError> => {
  const { provider: providerId, capabilities } = context;
  const unsupported = findUnsupportedComposeKnob(collectComposeKnobs(services), capabilities);
  if (unsupported === undefined) return Effect.void;
  return Effect.fail(
    new CapabilityError({
      message: `Service ${unsupported.service} uses Compose runtime knob ${unsupported.key}, which provider ${String(providerId)} does not support.`,
      service: unsupported.service,
      key: unsupported.key,
      feature: `compose knob ${unsupported.key}`,
      capability: "composeSpec",
      providerId: String(providerId),
      remediation: capabilityRemediation(
        context,
        `Remove ${unsupported.key} from service ${unsupported.service}`,
        (alternative) => findUnsupportedComposeKnob([unsupported], alternative) === undefined,
      ),
    }),
  );
};

export const assertComposeServiceFieldsSupported = (
  context: CapabilityContext,
  services: ComposeServices,
): Effect.Effect<void, CapabilityError> => {
  const { provider: providerId, capabilities } = context;
  const use = findUnsupportedComposeServiceField(collectComposeServiceFields(services), capabilities);
  if (use === undefined) return Effect.void;
  return Effect.fail(
    new CapabilityError({
      message: `Service ${use.service} uses Compose service field ${use.key}, which provider ${String(providerId)} does not support.`,
      service: use.service,
      key: use.key,
      feature: `compose service field ${use.key}`,
      capability: "composeSpec",
      providerId: String(providerId),
      remediation: capabilityRemediation(
        context,
        `Remove ${use.key} from service ${use.service}`,
        (alternative) => findUnsupportedComposeServiceField([use], alternative) === undefined,
      ),
    }),
  );
};

export const assertComposeProjectFieldsSupported = (
  context: CapabilityContext,
  extensions: AppPlan["extensions"],
): Effect.Effect<void, CapabilityError> => {
  const { provider: providerId, capabilities } = context;
  const use = findUnsupportedComposeProjectField(collectComposeProjectFields(extensions), capabilities);
  if (use === undefined) return Effect.void;
  return Effect.fail(
    new CapabilityError({
      message: `App uses Compose project field ${use.key}, which provider ${String(providerId)} does not support.`,
      key: use.key,
      feature: `compose project field ${use.key}`,
      capability: "composeSpec",
      providerId: String(providerId),
      remediation: capabilityRemediation(
        context,
        `Remove top-level ${use.key}`,
        (alternative) => findUnsupportedComposeProjectField([use], alternative) === undefined,
      ),
    }),
  );
};

export const assertComposePreservedPathsSupported = (
  context: CapabilityContext,
  services: ComposeServices,
): Effect.Effect<void, CapabilityError> => {
  const { provider: providerId, capabilities } = context;
  const use = findUnsupportedComposePreservedPath(collectComposePreservedPaths(services), capabilities);
  if (use === undefined) return Effect.void;
  return Effect.fail(
    new CapabilityError({
      message: `Service ${use.service} uses preserved Compose path ${use.key}, which provider ${String(providerId)} does not support.`,
      service: use.service,
      key: use.key,
      feature: `compose preserved path ${use.key}`,
      capability: "composeSpec",
      providerId: String(providerId),
      remediation: capabilityRemediation(
        context,
        `Remove ${use.key} from service ${use.service}`,
        (alternative) => findUnsupportedComposePreservedPath([use], alternative) === undefined,
      ),
    }),
  );
};

/** Service fields, then preserved paths, then project fields: the first unsupported one fails. */
export const assertComposeFieldsSupported = (
  context: CapabilityContext,
  plan: { readonly services: ComposeServices; readonly extensions: AppPlan["extensions"] },
): Effect.Effect<void, CapabilityError> =>
  assertComposeServiceFieldsSupported(context, plan.services).pipe(
    Effect.andThen(assertComposePreservedPathsSupported(context, plan.services)),
    Effect.andThen(assertComposeProjectFieldsSupported(context, plan.extensions)),
  );

export const serviceBindRemediation = (serviceName: string) =>
  `Choose a provider with bind mount support or remove bind mounts from service ${serviceName}.`;

export const serviceArtifactBuildRemediation = (serviceName: string) =>
  `Choose a provider with artifact build support or replace the build artifact for service ${serviceName} with a pre-built image reference.`;

export const providerSatisfiesCapability = (
  providerCapabilities: ProviderCapabilities,
  capability: keyof ProviderCapabilities,
): boolean => {
  const value = providerCapabilities[capability];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "none";
  return value !== undefined;
};

export const appFeatureCapabilityError = (
  providerId: ProviderId,
  feature: string,
  capability: keyof ProviderCapabilities,
) =>
  new CapabilityError({
    message: `App feature ${feature} requires provider capability ${String(capability)}.`,
    feature,
    capability: String(capability),
    providerId: String(providerId),
    remediation: `Choose a provider that supports ${String(capability)} or remove the app feature requiring it.`,
  });
