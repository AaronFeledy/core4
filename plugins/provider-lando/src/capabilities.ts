import {
  type HostProxyContainerTarget,
  agentSocketCapabilities,
  buildProviderCapabilities,
  decodeProviderCapabilitiesFor,
  engineInfoArchitecture,
  hostProxyCapabilities,
  hostProxyContainerTargets,
} from "@lando/container-runtime/capabilities";
import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { composeKnobsForDialect } from "@lando/container-runtime/podman/compose-knobs";
import { mapFailures } from "@lando/sdk/command-result";
import { Effect } from "effect";

import {
  ProviderCapabilityError,
  ProviderInternalError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  type AgentSocketDelivery,
  type HostPlatform,
  type ProviderCapabilities,
  hostPlatformFamily,
} from "@lando/sdk/schema";

import {
  type DelegatedScopeHost,
  delegatedLaunchEligibility,
  delegatedScopeRemediation,
} from "./delegated-scope.ts";

const PROVIDER_ID = "lando";

export const agentSocketDeliveryForPlatform = (
  family: ReturnType<typeof hostPlatformFamily>,
): AgentSocketDelivery =>
  (({ linux: "bind-directory", darwin: "guest-bridge", win32: "guest-bridge" }) as const)[family];

const bindMountPerformanceForPlatform = (
  platform: HostPlatform,
): ProviderCapabilities["bindMountPerformance"] => {
  return hostPlatformFamily(platform) === "linux" ? "native" : "slow";
};

const podmanInfoRootless = (info: unknown): boolean | undefined => {
  if (typeof info !== "object" || info === null || !("host" in info)) return undefined;
  const host = info.host;
  if (typeof host !== "object" || host === null || !("security" in host)) return undefined;
  const security = host.security;
  if (typeof security !== "object" || security === null || !("rootless" in security)) return undefined;
  return typeof security.rootless === "boolean" ? security.rootless : undefined;
};

export const decodeProviderCapabilities = decodeProviderCapabilitiesFor(PROVIDER_ID);

const libpodComposeKnobs = composeKnobsForDialect("libpod");
// Podman gives a container its own cgroup, and so applies `deploy.resources`, only when the
// service runs in a cgroup delegated to the user. That holds for a managed Linux service started
// in a delegated systemd user scope; it is unverified for machine-backed hosts and unknown for an
// external socket, so the knob stays withheld unless resource control is established.
const withheldResourceComposeKnobs = libpodComposeKnobs.filter((key) => key !== "deploy.resources");

/** Whether containers get their own cgroups, deciding the `deploy.resources` knob. */
export type ResourceControl =
  | { readonly declared: true }
  | { readonly declared: false; readonly remediation?: string };

export const withResourceControl = (
  capabilities: ProviderCapabilities,
  control: ResourceControl,
): ProviderCapabilities => ({
  ...capabilities,
  composeKnobs: control.declared
    ? { supported: libpodComposeKnobs }
    : {
        supported: withheldResourceComposeKnobs,
        ...(control.remediation === undefined
          ? {}
          : { withheld: [{ key: "deploy.resources", remediation: control.remediation }] }),
      },
});

/** Resource control the next managed Linux launch provides, from a few host stat/reads. */
export const linuxResourceControl = (platform: HostPlatform, host: DelegatedScopeHost): ResourceControl => {
  const eligibility = delegatedLaunchEligibility(platform, host);
  return eligibility.eligible
    ? { declared: true }
    : { declared: false, remediation: delegatedScopeRemediation(eligibility.reason) };
};

/**
 * Service-level Compose fields that stay undeclared so the planner's
 * fail-closed capability gate rejects them before provider execution:
 *
 * - `secrets` — content comes from top-level entries (`file`,
 *   `content`, `environment`, or `external`). Those entries survive only in
 *   `AppPlan.extensions.compose`; they are never normalized into provider
 *   input, so there is no source content to mount.
 * - `profiles` — Compose starts a profiled service only when its profile is
 *   activated. Lando has no profile-activation surface, so declaring support
 *   would promise activation that does not exist.
 *
 * `configs` is declared: file-backed top-level entries plus service grants are
 * realized as read-only bind mounts. `external: true` fails closed at plan time.
 * Normalized `networks` uses authoredNetworks to add attachments and aliases
 * without removing app/shared membership. Other attachment settings are rejected.
 *
 * Service-level `x-*` fields are outside the capability surface and remain
 * inert metadata preserved by core. `labels` is declared because both direct
 * container creation and Compose emission realize preserved labels.
 */
export const providerLandoCapabilitiesForPlatform = (
  platform: HostPlatform,
  containerTargets: ReadonlyArray<HostProxyContainerTarget> = [],
  rootless = hostPlatformFamily(platform) !== "win32",
): ProviderCapabilities => {
  const family = hostPlatformFamily(platform);
  const agentSocket = agentSocketCapabilities(agentSocketDeliveryForPlatform(family));
  return buildProviderCapabilities({
    bindMounts: true,
    artifactBuild: true,
    artifactPull: true,
    bindMountPerformance: bindMountPerformanceForPlatform(family),
    volumeSnapshot: "native",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "lando",
    rootless,
    composeSpec: "native",
    composeKnobs: { supported: withheldResourceComposeKnobs },
    composeServiceFields: { supported: ["labels", "configs"] },
    authoredNetworks: true,
    composeProjectFields: { supported: ["configs"] },
    providerExtensions: [],
    hostProxy: hostProxyCapabilities(family, containerTargets, "host.containers.internal"),
    ...(agentSocket === undefined ? {} : { agentSocket }),
  });
};

export const linuxMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("linux");
export const macosMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("darwin");
export const windowsMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("win32");
export const mvpProviderCapabilities = (platform: HostPlatform, arch?: string): ProviderCapabilities =>
  providerLandoCapabilitiesForPlatform(platform, hostProxyContainerTargets(arch));

/**
 * Offline declaration for the managed runtime on this host: Linux declares `deploy.resources`
 * when the next launch can run in a delegated systemd user scope; macOS and Windows withhold it.
 */
export const declaredProviderLandoCapabilities = (
  platform: HostPlatform,
  arch: string | undefined,
  host: DelegatedScopeHost,
): ProviderCapabilities => {
  const capabilities = mvpProviderCapabilities(platform, arch);
  return hostPlatformFamily(platform) === "linux"
    ? withResourceControl(capabilities, linuxResourceControl(platform, host))
    : capabilities;
};

export const introspectProviderCapabilities = (
  api: PodmanApiClient,
  platform: HostPlatform,
): Effect.Effect<ProviderCapabilities, ProviderCapabilityError | ProviderUnavailableError> =>
  api.info.pipe(
    mapFailures((cause): ProviderCapabilityError | ProviderUnavailableError =>
      cause instanceof ProviderInternalError
        ? new ProviderCapabilityError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: "Podman API info could not be decoded for capability introspection.",
            capability: "podman-info",
            requiredValue: "valid Podman API info response",
            actualValue: cause.details,
            cause,
            remediation:
              "Choose a provider that supports `podman-info`, or remove that requirement from the app.",
          })
        : cause,
    ),
    Effect.map((info) => {
      const containerArch = engineInfoArchitecture(info);
      return providerLandoCapabilitiesForPlatform(
        platform,
        hostProxyContainerTargets(containerArch),
        podmanInfoRootless(info) ?? hostPlatformFamily(platform) !== "win32",
      );
    }),
  );
