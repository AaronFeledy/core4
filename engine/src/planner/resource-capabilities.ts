import { CapabilityError, PublicationUnsupportedError } from "@lando/sdk/errors";
import type { ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { SSH_AGENT_FEATURE_ID } from "../subsystems/ssh/api.ts";
import {
  missingCapability,
  providerSatisfiesCapability,
  serviceArtifactBuildRemediation,
  serviceBindRemediation,
} from "./compose-capabilities.ts";

export const serviceResourceCapabilityErrors = (
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  intent: {
    readonly name: string;
    readonly bindMounts?: boolean;
    readonly artifactBuild?: boolean;
    readonly persistentStorage?: boolean;
  },
): readonly CapabilityError[] => [
  ...(intent.bindMounts && (!capabilities.bindMounts || capabilities.bindMountPerformance === "none")
    ? [
        missingCapability(
          provider,
          intent.name,
          "bind mount",
          "bindMounts",
          serviceBindRemediation(intent.name),
        ),
      ]
    : []),
  ...(intent.artifactBuild && !capabilities.artifactBuild
    ? [
        missingCapability(
          provider,
          intent.name,
          "artifact build",
          "artifactBuild",
          serviceArtifactBuildRemediation(intent.name),
        ),
      ]
    : []),
  ...(intent.persistentStorage && !capabilities.persistentStorage
    ? [
        missingCapability(
          provider,
          intent.name,
          "persistent storage",
          "persistentStorage",
          `Choose a provider with persistent storage support or remove persistent storage from service ${intent.name}.`,
        ),
      ]
    : []),
];

export const assertRouteNetworkingSupported = (
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  hasRoutes: boolean,
): Effect.Effect<void, CapabilityError> =>
  hasRoutes && !capabilities.sharedCrossAppNetwork
    ? Effect.fail(
        new CapabilityError({
          message: "Routes require provider capability sharedCrossAppNetwork.",
          feature: "routes",
          capability: "sharedCrossAppNetwork",
          providerId: String(provider),
          remediation: "Choose a provider with shared cross-app networking or remove the authored routes.",
        }),
      )
    : Effect.void;

export const agentSocketCapabilityErrors = (
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  intent: { readonly name: string; readonly hostSsh: boolean; readonly gpgForward: boolean },
): readonly CapabilityError[] =>
  providerSatisfiesCapability(capabilities, "agentSocket")
    ? []
    : [
        ...(intent.hostSsh
          ? [
              missingCapability(
                provider,
                intent.name,
                SSH_AGENT_FEATURE_ID,
                "agentSocket",
                "Select a provider that advertises agentSocket delivery or set sshAgent.sidecar to true to use best-effort sidecar forwarding.",
              ),
            ]
          : []),
        ...(intent.gpgForward
          ? [
              missingCapability(
                provider,
                intent.name,
                "lando.gpg-agent",
                "agentSocket",
                "Select a provider with agentSocket delivery or disable gpgAgent.forward.",
              ),
            ]
          : []),
      ];

export const requiredLogSourceCapabilityError = (
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  source: { readonly name: string; readonly id?: string },
): CapabilityError | undefined =>
  capabilities.serviceLogSources || source.id === undefined
    ? undefined
    : missingCapability(
        provider,
        source.name,
        `required follow log source ${source.id}`,
        "serviceLogSources",
        `Use strategy: redirect for service ${source.name} log source ${source.id}, or choose a provider that advertises serviceLogSources.`,
      );

export const publicationCapabilityError = (
  provider: ProviderId,
  capabilities: ProviderCapabilities,
  intent: { readonly name: string; readonly published: boolean },
): PublicationUnsupportedError | undefined =>
  intent.published && capabilities.hostPortPublish === "none"
    ? new PublicationUnsupportedError({
        message: `Provider ${provider} cannot publish endpoints for service ${intent.name}.`,
        providerId: provider,
        service: intent.name,
        capability: "hostPortPublish",
        remediation: `Choose a provider with host port publish support or make service ${intent.name} endpoints internal.`,
      })
    : undefined;
