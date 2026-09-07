import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { podmanComposeKnobs } from "@lando/container-runtime/podman/compose-knobs";
import { Effect, Schema } from "effect";

import {
  ProviderCapabilityError,
  ProviderInternalError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type HostPlatform, ProviderCapabilities, hostPlatformFamily } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";

const bindMountPerformanceForPlatform = (
  platform: HostPlatform,
): ProviderCapabilities["bindMountPerformance"] => {
  return hostPlatformFamily(platform) === "linux" ? "native" : "slow";
};

type HostProxyCapabilities = NonNullable<ProviderCapabilities["hostProxy"]>;
type HostProxyContainerTarget = HostProxyCapabilities["containerTargets"][number];

const hostProxyTcpHostGateway = (platform: HostPlatform): string | undefined =>
  hostPlatformFamily(platform) === "win32" ? "host.containers.internal" : undefined;

const hostProxyContainerTarget = (arch?: string): ReadonlyArray<HostProxyContainerTarget> => {
  if (arch === "x64" || arch === "amd64" || arch === "x86_64") {
    return [{ os: "linux", arch: "x64" }];
  }
  if (arch === "arm64" || arch === "aarch64") return [{ os: "linux", arch: "arm64" }];
  return [];
};

const hostProxyCapabilities = (
  platform: HostPlatform,
  containerTargets: ReadonlyArray<HostProxyContainerTarget>,
): HostProxyCapabilities | undefined => {
  const tcpHostGateway = hostProxyTcpHostGateway(platform);
  if (containerTargets.length === 0 && tcpHostGateway === undefined) return undefined;
  return {
    containerTargets,
    ...(tcpHostGateway === undefined ? {} : { tcpHostGateway }),
  };
};

const podmanInfoArchitecture = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const host = "host" in info ? info.host : undefined;
  if (typeof host === "object" && host !== null && "arch" in host && typeof host.arch === "string") {
    return host.arch;
  }
  if ("Architecture" in info && typeof info.Architecture === "string") return info.Architecture;
  return undefined;
};

export const decodeProviderCapabilities = (input: unknown) =>
  Schema.decodeUnknown(ProviderCapabilities)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "provider-lando returned invalid ProviderCapabilities.",
          capability: "ProviderCapabilities",
          requiredValue: "@lando/sdk/schema ProviderCapabilities",
          actualValue: input,
          cause,
        }),
    ),
  );

/**
 * Service-level Compose fields that stay undeclared so the planner's
 * fail-closed capability gate rejects them before provider execution:
 *
 * - `networks` — Compose attaches a service only to its listed networks, with
 *   an implicit `default` when absent. provider-lando instead attaches every
 *   service to every planned network: `bring-up.ts`'s `createContainerRequest`
 *   builds `NetworkingConfig.EndpointsConfig` from `networkNames(plan)`, and
 *   `compose.ts` does the same. The planner hardcodes `AppPlan.networks` to one
 *   app bridge, while aliases, static IPv4/IPv6, `link_local_ips`,
 *   `mac_address`, `priority`, `gw_priority`, and `interface_name` are
 *   unrealized.
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
 *
 * Service-level `x-*` fields are outside the capability surface and remain
 * inert metadata preserved by core. `labels` is declared because both direct
 * container creation and Compose emission realize preserved labels.
 */
export const providerLandoCapabilitiesForPlatform = (
  platform: HostPlatform,
  containerTargets: ReadonlyArray<HostProxyContainerTarget> = [],
): ProviderCapabilities => {
  const family = hostPlatformFamily(platform);
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
    rootless: true,
    composeSpec: "native",
    composeKnobs: { supported: podmanComposeKnobs() },
    composeServiceFields: { supported: ["labels", "configs"] },
    composeProjectFields: { supported: ["configs"] },
    providerExtensions: [],
    hostProxy: hostProxyCapabilities(family, containerTargets),
  });
};

export const linuxMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("linux");
export const macosMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("darwin");
export const windowsMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("win32");
export const mvpProviderCapabilities = (platform: HostPlatform, arch?: string): ProviderCapabilities =>
  providerLandoCapabilitiesForPlatform(platform, hostProxyContainerTarget(arch));

export const introspectProviderCapabilities = (
  api: PodmanApiClient,
  platform: HostPlatform,
): Effect.Effect<ProviderCapabilities, ProviderCapabilityError | ProviderUnavailableError> =>
  api.info.pipe(
    Effect.mapError((cause): ProviderCapabilityError | ProviderUnavailableError =>
      cause instanceof ProviderInternalError
        ? new ProviderCapabilityError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: "Podman API info could not be decoded for capability introspection.",
            capability: "podman-info",
            requiredValue: "valid Podman API info response",
            actualValue: cause.details,
            cause,
          })
        : cause,
    ),
    Effect.map((info) => {
      const containerArch = podmanInfoArchitecture(info);
      return providerLandoCapabilitiesForPlatform(platform, hostProxyContainerTarget(containerArch));
    }),
  );
