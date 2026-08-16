// The single sanctioned engine-coupling point for core tests: append-only during migration, shrink-only after.

export {
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  writeCachedAppPlan,
} from "@lando/engine/cache/app-plan";
export { decodeAppCommandIndex, decodePluginCommandIndex } from "@lando/engine/cache/command-index";
export {
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
export { writeCwdAppMapEntry } from "@lando/engine/cache/cwd-app-map";
export {
  appCommandCachePath,
  appToolingCompilationCachePath,
  pluginCommandCachePath,
} from "@lando/engine/cache/paths";
export { CacheServiceLive } from "@lando/engine/cache/service";
export { getAtPath, setAtPath, unsetAtPath } from "@lando/engine/config-write/dot-path";
export { parseTypedValue, type ValueType } from "@lando/engine/config-write/value-parse";
export {
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  parseConfigPath,
  parseConfigValue,
} from "@lando/engine/config-write/write-core";
export { managedFileLedger } from "@lando/engine/config/roots";
export { providerImages } from "@lando/engine/data-mover/generated/provider-images";
export { DataMoverLive } from "@lando/engine/data-mover/service";
export { registerBuiltInContractDeprecations } from "@lando/engine/deprecation/built-in-contracts";
export { DeprecationServiceLive } from "@lando/engine/deprecation/service";
export { GlobalAppServiceLive } from "@lando/engine/global-app/service";
export {
  assertLandoVersionConstraint,
  assertUserAppIdNotReserved,
  loadUserLandofile,
  loadUserLandofileAt,
  loadUserLandofileFile,
} from "@lando/engine/landofile/app-resolution";
export { publishedEndpointUrl, publishedEndpointUrls } from "@lando/engine/operations/authority-url";
export { config, ConfigResultSchema, type EditorRunner } from "@lando/engine/operations/config";
export {
  ensureGlobalServicesRunning,
  requiredGlobalServicesForPlan,
} from "@lando/engine/operations/ensure-global-services";
export { globalInstall } from "@lando/engine/operations/global-install";
export type { InfoAppResult } from "@lando/engine/operations/info";
export { logsAppForTarget } from "@lando/engine/operations/logs";
export { PLUGIN_NEW_TEMPLATE_IDS } from "@lando/engine/operations/plugin-scaffold";
export { publishTaskStart } from "@lando/engine/operations/progress";
export {
  assertToolingNameClaimable,
  reservedTopLevelAliasOwner,
} from "@lando/engine/operations/reserved-aliases";
export { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
export { buildToolingInvocation, validateToolingArguments } from "@lando/engine/operations/tooling";
export { buildUninstallPlan, uninstall, type UninstallResult } from "@lando/engine/operations/uninstall";
export {
  buildWindowsReplacementScript,
  defaultFetchManifestBytes,
  resolveUpdateManifestUrl,
  scheduleWindowsReplacement,
  update,
  updateChannelForVersion,
  type UpdateChecksumSignatureVerifier,
  UpdateLaunchProbeError,
  type UpdateManifestFetcher,
  type UpdateManifestSignatureVerifier,
  UpdateMinimumVersionError,
  UpdatePermissionError,
  type UpdateWindowsReplacementSpawnInput,
} from "@lando/engine/operations/update";
export { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
export { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
export { makePluginRegistryLive, PluginRegistryLive } from "@lando/engine/plugins/registry";
export { makePluginTrustStore } from "@lando/engine/plugins/trust-store";
export {
  cliRuntimeOptions,
  effectiveBootstrapForCommand,
  resolveCliTelemetryState,
} from "@lando/engine/runtime/cli-options";
export { RuntimeCwd } from "@lando/engine/runtime/cwd";
export { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
export type { ManagedProviderMachineClassification } from "@lando/engine/runtime/managed-provider-machine";
export {
  makeScratchRegistry,
  ScratchRegistry,
  type ScratchRegistryEntry,
  ScratchRegistryLive,
} from "@lando/engine/scratch-app/registry";
export { ScratchResourceScanner, ScratchResourceScannerLive } from "@lando/engine/scratch-app/scanner";
export {
  makeScratchAppServiceLive,
  readScratchLandofile,
  resolveScratchAcquireIsolation,
} from "@lando/engine/scratch-app/service";
export { BuildOrchestratorLive } from "@lando/engine/services/build-orchestrator";
export { ConfigServiceLive } from "@lando/engine/services/config";
export { EventServiceLive } from "@lando/engine/services/event-service";
export { FileSystemLive } from "@lando/engine/services/file-system";
export { validateGlobalServiceContributions } from "@lando/engine/services/global-services";
export {
  LandofileServiceLive,
  makeEngineLandofileServiceLive,
  resolveLandofileIncludes,
} from "@lando/engine/services/landofile-live";
export { AppPlannerLive } from "@lando/engine/services/planner";
export { makeEnvSecretStoreLive, SecretStoreLive } from "@lando/engine/services/secret-store";
export { makeShellRunnerLive } from "@lando/engine/services/shell-runner";
export { ProviderExecToolingEngineLive } from "@lando/engine/services/tooling-engine";
export { CertificateAuthorityUnavailableLive } from "@lando/engine/subsystems/certs/api";
export { HealthcheckRunnerUnavailableLive } from "@lando/engine/subsystems/healthcheck/api";
export { HostProxyServiceDisabledLive } from "@lando/engine/subsystems/host-proxy/api";
export {
  dispatchRunLando,
  type HostProxyRunLandoExecutor,
} from "@lando/engine/subsystems/host-proxy/dispatch";
export { buildRunLandoRequest } from "@lando/engine/subsystems/host-proxy/shim";
export { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport";
export {
  HOST_PROXY_WORKER_PROTOCOL_VERSION,
  writeWorkerRecord,
} from "@lando/engine/subsystems/host-proxy/worker-state";
export { ProxyServiceUnavailableLive } from "@lando/engine/subsystems/proxy/api";
export { UrlScannerUnavailableLive } from "@lando/engine/subsystems/scanner/api";
export { SshServiceUnavailableLive } from "@lando/engine/subsystems/ssh/api";
export {
  recordUpdateOutcomeTelemetry,
  TELEMETRY_EVENT_INVENTORY,
  type UpdateOutcome,
  updateOutcomeFromError,
} from "@lando/engine/telemetry/events";
