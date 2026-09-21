import { Schema } from "effect";

import { ProviderCapabilities } from "@lando/sdk/schema";
import {
  type HostPlatform,
  type ProviderCapabilities as ProviderCapabilitiesShape,
  hostPlatformFamily,
} from "@lando/sdk/schema";

export type HostProxyCapabilities = NonNullable<ProviderCapabilitiesShape["hostProxy"]>;
export type HostProxyContainerTarget = HostProxyCapabilities["containerTargets"][number];

export const hostProxyContainerTargets = (arch?: string): ReadonlyArray<HostProxyContainerTarget> => {
  if (arch === "x64" || arch === "amd64" || arch === "x86_64") {
    return [{ os: "linux", arch: "x64" }];
  }
  if (arch === "arm64" || arch === "aarch64") return [{ os: "linux", arch: "arm64" }];
  return [];
};

export const hostProxyCapabilities = (
  platform: HostPlatform,
  containerTargets: ReadonlyArray<HostProxyContainerTarget>,
  windowsGateway: string,
): HostProxyCapabilities | undefined => {
  const tcpHostGateway = hostPlatformFamily(platform) === "win32" ? windowsGateway : undefined;
  if (containerTargets.length === 0 && tcpHostGateway === undefined) return undefined;
  return {
    containerTargets,
    ...(tcpHostGateway === undefined ? {} : { tcpHostGateway }),
  };
};

export const engineInfoArchitecture = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const host = "host" in info ? info.host : undefined;
  if (typeof host === "object" && host !== null && "arch" in host && typeof host.arch === "string") {
    return host.arch;
  }
  return "Architecture" in info && typeof info.Architecture === "string" ? info.Architecture : undefined;
};

export interface ProviderCapabilityConstants {
  readonly bindMounts: ProviderCapabilitiesShape["bindMounts"];
  readonly bindMountPerformance: ProviderCapabilitiesShape["bindMountPerformance"];
  readonly volumeSnapshot?: ProviderCapabilitiesShape["volumeSnapshot"];
  readonly serviceFileCopy?: ProviderCapabilitiesShape["serviceFileCopy"];
  readonly artifactBuild?: ProviderCapabilitiesShape["artifactBuild"];
  readonly artifactPull?: ProviderCapabilitiesShape["artifactPull"];
  readonly artifactExport?: ProviderCapabilitiesShape["artifactExport"];
  readonly artifactImport?: ProviderCapabilitiesShape["artifactImport"];
  readonly ephemeralMounts?: ProviderCapabilitiesShape["ephemeralMounts"];
  readonly tlsCertificates: ProviderCapabilitiesShape["tlsCertificates"];
  readonly rootless: ProviderCapabilitiesShape["rootless"];
  readonly architectureEmulation?: ProviderCapabilitiesShape["architectureEmulation"];
  readonly composeSpec: ProviderCapabilitiesShape["composeSpec"];
  readonly composeKnobs?: ProviderCapabilitiesShape["composeKnobs"];
  readonly composeProjectFields?: ProviderCapabilitiesShape["composeProjectFields"];
  readonly composePreservedPaths?: ProviderCapabilitiesShape["composePreservedPaths"];
  readonly composeServiceFields?: ProviderCapabilitiesShape["composeServiceFields"];
  readonly providerExtensions: ProviderCapabilitiesShape["providerExtensions"];
  readonly hostProxy?: ProviderCapabilitiesShape["hostProxy"];
}

export const buildProviderCapabilities = (
  constants: ProviderCapabilityConstants,
): ProviderCapabilitiesShape =>
  Schema.decodeSync(ProviderCapabilities)({
    artifactBuild: constants.artifactBuild ?? false,
    artifactPull: constants.artifactPull ?? false,
    buildSecrets: false,
    buildSsh: false,
    multiServiceApply: true,
    serviceExec: true,
    serviceLogs: true,
    serviceLogSources: true,
    serviceHealth: "lando",
    hostReachability: "emulated",
    sharedCrossAppNetwork: true,
    persistentStorage: true,
    bindMounts: constants.bindMounts,
    bindMountPerformance: constants.bindMountPerformance,
    copyMounts: false,
    copyOnWriteAppRoot: false,
    volumeSnapshot: constants.volumeSnapshot ?? "none",
    serviceFileCopy: constants.serviceFileCopy ?? "exec",
    artifactExport: constants.artifactExport ?? false,
    artifactImport: constants.artifactImport ?? false,
    ephemeralMounts: constants.ephemeralMounts ?? false,
    hostPortPublish: "proxy",
    routeProvider: false,
    tlsCertificates: constants.tlsCertificates,
    rootless: constants.rootless,
    privilegedServices: false,
    architectureEmulation: constants.architectureEmulation ?? false,
    composeSpec: constants.composeSpec,
    composeKnobs: constants.composeKnobs ?? { supported: [] },
    ...(constants.composeProjectFields === undefined
      ? {}
      : { composeProjectFields: constants.composeProjectFields }),
    ...(constants.composeServiceFields === undefined
      ? {}
      : { composeServiceFields: constants.composeServiceFields }),
    ...(constants.composePreservedPaths === undefined
      ? {}
      : { composePreservedPaths: constants.composePreservedPaths }),
    providerExtensions: constants.providerExtensions,
    ...(constants.hostProxy === undefined ? {} : { hostProxy: constants.hostProxy }),
  });
