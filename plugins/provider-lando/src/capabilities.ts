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
import { Effect } from "effect";

import {
  type DelegatedScopeHost,
  type UserSystemdTools,
  delegatedLaunchEligibility,
  delegatedScopeRemediation,
  userSystemdTools,
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

/**
 * Whether the managed service runs in a delegated systemd user scope, so containers get their own
 * cgroups. It decides the `deploy.resources` knob and, with the user's systemd tools, native health.
 */
export type ManagedPlacement =
  | { readonly delegated: true }
  | { readonly delegated: false; readonly remediation?: string };

export const withResourceControl = (
  capabilities: ProviderCapabilities,
  placement: ManagedPlacement,
): ProviderCapabilities => ({
  ...capabilities,
  composeKnobs: placement.delegated
    ? { supported: libpodComposeKnobs }
    : {
        supported: withheldResourceComposeKnobs,
        ...(placement.remediation === undefined
          ? {}
          : { withheld: [{ key: "deploy.resources", remediation: placement.remediation }] }),
      },
});

/**
 * Lando schedules native healthchecks for the managed Linux runtime with systemd user timers. The
 * timers bind to the service's delegated scope, and Lando realizes `healthcheck.start_interval`
 * with a start-phase timer, which Podman itself drops.
 */
export const withNativeHealth = (
  capabilities: ProviderCapabilities,
  scheduled: boolean,
): ProviderCapabilities =>
  scheduled
    ? {
        ...capabilities,
        serviceHealth: "lando",
        composePreservedPaths: { supported: ["healthcheck.start_interval"] },
      }
    : capabilities;

/**
 * The user's systemd tools when Lando can schedule native health: a delegated service and a
 * reachable user manager. The offline declaration and the live provider both decide with this.
 */
export const nativeHealthScheduler = (
  platform: HostPlatform,
  placement: ManagedPlacement,
  host: DelegatedScopeHost,
): UserSystemdTools | undefined => {
  if (!placement.delegated) return undefined;
  const tools = userSystemdTools(platform, host);
  return typeof tools === "string" ? undefined : tools;
};

/** Placement the next managed Linux launch provides, from a few host stat/reads. */
export const linuxPlacement = (platform: HostPlatform, host: DelegatedScopeHost): ManagedPlacement => {
  const eligibility = delegatedLaunchEligibility(platform, host);
  return eligibility.eligible
    ? { delegated: true }
    : { delegated: false, remediation: delegatedScopeRemediation(eligibility.reason) };
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
  // A user namespace maps one container id to the host user only on a rootless
  // Linux engine. macOS and Windows run the engine in a VM, where the host
  // bind identity is neither the container id nor a knowable host id.
  const projectUserMapping =
    family === "linux" && rootless ? ("userns-keep-id" as const) : ("unsupported" as const);
  const bindOwnership =
    family !== "linux"
      ? ("unknown" as const)
      : rootless
        ? ("root-is-host-user" as const)
        : ("host-ids" as const);
  return buildProviderCapabilities({
    bindMounts: true,
    // The machine's Podman runs under the VM's systemd and schedules its own timers. The managed
    // Linux service runs off the user's bus, so nothing schedules them until Lando does.
    serviceHealth: family === "linux" ? "none" : "native",
    artifactBuild: true,
    artifactPull: true,
    bindMountPerformance: bindMountPerformanceForPlatform(family),
    serializesVolumeCopyUp: true,
    volumeSnapshot: "native",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "lando",
    rootless,
    projectUserMapping,
    bindOwnership,
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
 * Offline declaration for the managed runtime on this host: on Linux, when the next launch can run
 * in a delegated systemd user scope, it declares `deploy.resources` and, with a reachable user
 * manager, Lando-scheduled native health. macOS and Windows withhold `deploy.resources`.
 */
export const declaredProviderLandoCapabilities = (
  platform: HostPlatform,
  arch: string | undefined,
  host: DelegatedScopeHost,
): ProviderCapabilities => {
  const capabilities = mvpProviderCapabilities(platform, arch);
  if (hostPlatformFamily(platform) !== "linux") return capabilities;
  const placement = linuxPlacement(platform, host);
  return withNativeHealth(
    withResourceControl(capabilities, placement),
    nativeHealthScheduler(platform, placement, host) !== undefined,
  );
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
