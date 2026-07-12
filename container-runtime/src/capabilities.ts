import { Schema } from "effect";

import { ProviderCapabilities } from "@lando/sdk/schema";
import type { ProviderCapabilities as ProviderCapabilitiesShape } from "@lando/sdk/schema";

export interface ProviderCapabilityConstants {
  readonly bindMounts: ProviderCapabilitiesShape["bindMounts"];
  readonly bindMountPerformance: ProviderCapabilitiesShape["bindMountPerformance"];
  readonly volumeSnapshot?: ProviderCapabilitiesShape["volumeSnapshot"];
  readonly serviceFileCopy?: ProviderCapabilitiesShape["serviceFileCopy"];
  readonly artifactBuild?: ProviderCapabilitiesShape["artifactBuild"];
  readonly artifactExport?: ProviderCapabilitiesShape["artifactExport"];
  readonly artifactImport?: ProviderCapabilitiesShape["artifactImport"];
  readonly ephemeralMounts?: ProviderCapabilitiesShape["ephemeralMounts"];
  readonly tlsCertificates: ProviderCapabilitiesShape["tlsCertificates"];
  readonly rootless: ProviderCapabilitiesShape["rootless"];
  readonly composeSpec: ProviderCapabilitiesShape["composeSpec"];
  readonly providerExtensions: ProviderCapabilitiesShape["providerExtensions"];
  readonly hostProxy?: ProviderCapabilitiesShape["hostProxy"];
}

export const buildProviderCapabilities = (
  constants: ProviderCapabilityConstants,
): ProviderCapabilitiesShape =>
  Schema.decodeSync(ProviderCapabilities)({
    artifactBuild: constants.artifactBuild ?? false,
    artifactPull: false,
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
    composeSpec: constants.composeSpec,
    providerExtensions: constants.providerExtensions,
    ...(constants.hostProxy === undefined ? {} : { hostProxy: constants.hostProxy }),
  });
