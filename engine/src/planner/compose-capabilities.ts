/** Provider capability checks for authored Compose intent. */
import { Effect } from "effect";

import { CapabilityError } from "@lando/sdk/errors";
import type { AppPlan, ProviderCapabilities, ProviderId } from "@lando/sdk/schema";

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

export const assertComposeKnobsSupported = (
  providerId: ProviderId,
  capabilities: ProviderCapabilities,
  services: AppPlan["services"],
): Effect.Effect<void, CapabilityError> => {
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
      remediation: `Remove ${unsupported.key} from service ${unsupported.service}, choose a provider that declares composeKnobs support for ${unsupported.key}, or move the intent under providers.<id>.`,
    }),
  );
};

export const assertComposeServiceFieldsSupported = (
  providerId: ProviderId,
  capabilities: ProviderCapabilities,
  services: AppPlan["services"],
): Effect.Effect<void, CapabilityError> => {
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
      remediation: `Remove ${use.key} from service ${use.service}, choose a provider that declares composeServiceFields support for ${use.family}, or move provider-specific intent under providers.<id>.`,
    }),
  );
};

export const assertComposeProjectFieldsSupported = (
  providerId: ProviderId,
  capabilities: ProviderCapabilities,
  extensions: AppPlan["extensions"],
): Effect.Effect<void, CapabilityError> => {
  const use = findUnsupportedComposeProjectField(collectComposeProjectFields(extensions), capabilities);
  if (use === undefined) return Effect.void;
  return Effect.fail(
    new CapabilityError({
      message: `App uses Compose project field ${use.key}, which provider ${String(providerId)} does not support.`,
      key: use.key,
      feature: `compose project field ${use.key}`,
      capability: "composeSpec",
      providerId: String(providerId),
      remediation: `Remove top-level ${use.key}, choose a provider that declares composeProjectFields support for ${use.key}, or move provider-specific intent under providers.<id>.`,
    }),
  );
};

export const assertComposePreservedPathsSupported = (
  providerId: ProviderId,
  capabilities: ProviderCapabilities,
  services: AppPlan["services"],
): Effect.Effect<void, CapabilityError> => {
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
      remediation: `Remove ${use.key} from service ${use.service}, choose a provider that declares composePreservedPaths support for ${use.key}, or move provider-specific intent under providers.<id>.`,
    }),
  );
};

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

export const bindRealization = (providerCapabilities: ProviderCapabilities) =>
  providerCapabilities.bindMountPerformance === "slow" ? "accelerated" : "passthrough";
