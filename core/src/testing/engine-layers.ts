// The single sanctioned engine-coupling point for core tests: append-only during migration, shrink-only after.

export {
  APP_PLAN_CACHE_HEADER_BYTES,
  APP_PLAN_CACHE_MAGIC,
  APP_PLAN_CACHE_SCHEMA_VERSION,
  deriveAppPlanCacheKey,
  readCachedAppPlan,
  readAppPlanSourceFingerprint,
  writeCachedAppPlan,
} from "@lando/engine/cache/app-plan";
export type { AppPlanCacheKeyInput } from "@lando/engine/cache/app-plan";
export { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";
export {
  APP_COMMAND_MAGIC,
  COMMAND_INDEX_HEADER_BYTES,
  COMMAND_INDEX_SCHEMA_VERSION,
  decodeAppCommandIndex,
  decodePluginCommandIndex,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
  PLUGIN_COMMAND_MAGIC,
} from "@lando/engine/cache/command-index";
export {
  invalidatePluginCommandCache,
  readAppCommandCache,
  readFreshAppCommandCacheForCwd,
  readPluginCommandCache,
  writeAppCommandCache,
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
export {
  CWD_APP_MAP_CACHE_FILE,
  CWD_APP_MAP_CACHE_HEADER_BYTES,
  CWD_APP_MAP_CACHE_MAGIC,
  CWD_APP_MAP_CACHE_SCHEMA_VERSION,
  deleteCwdAppMapEntry,
  listCwdAppMapEntries,
  readCwdAppMapEntry,
  writeCwdAppMapEntry,
} from "@lando/engine/cache/cwd-app-map";
export {
  appCommandCachePath,
  appPlanCachePath,
  appToolingCompilationCachePath,
  pluginCommandCachePath,
} from "@lando/engine/cache/paths";
export { CacheServiceLive } from "@lando/engine/cache/service";
export { hostProxyWorkerEntry, landofileRuntimeInputs } from "@lando/engine/composition";
export { getAtPath, setAtPath, unsetAtPath } from "@lando/engine/config-write/dot-path";
export { parseTypedValue, type ValueType } from "@lando/engine/config-write/value-parse";
export {
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  parseConfigPath,
  parseConfigValue,
} from "@lando/engine/config-write/write-core";
export { AGENT_CONTEXT_ENV_ALLOWLIST, resolveAgentContextEnv } from "@lando/engine/config/agent-env";
export { managedFileLedger } from "@lando/engine/config/roots";
export { providerImages } from "@lando/data-mover/provider-images";
export {
  __testOnlyEncodeTarOctal,
  __testOnlyUnarchivePayloadWithCap,
  DataMoverLive,
} from "@lando/data-mover/service";
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
export { resolveNotifyConfig } from "@lando/engine/lifecycle/subscriber-config";
export { makeSubscriberRegistrationClosure } from "@lando/engine/lifecycle/subscriber-index";
export { makeCachedSubscriberHandler } from "@lando/engine/lifecycle/subscriber-loader";
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
export {
  buildToolingInvocation,
  runTooling,
  validateToolingArguments,
} from "@lando/engine/operations/tooling";
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
export { attachEffectiveTooling, effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
export { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
export type { CertificateAuthorityResolverShape } from "@lando/engine/plugins/certificate-authority-resolver";
export { makeLandoPluginContext } from "@lando/engine/plugins/context";
export { mergeDiscoveredPlugins } from "@lando/engine/plugins/plugin-discovery";
export { makePluginRegistryLive, PluginRegistry, PluginRegistryLive } from "@lando/engine/plugins/registry";
export {
  findSetupFlagCollision,
  manifestSetupFlagContributions,
  SETUP_BUILTIN_FLAG_NAMES,
  SetupFlagCollisionError,
} from "@lando/engine/plugins/setup-flags";
export { makePluginTrustStore } from "@lando/engine/plugins/trust-store";
export {
  defaultLogFileHelperDistRoot,
  loadLogFileHelperPayloads,
  resolveLogFileHelperPayloadPath,
} from "@lando/engine/providers/log-file-helper-payloads";
export { resolveProviderSelection } from "@lando/engine/providers/precedence";
export { makeRuntimeProviderRegistry, RuntimeProviderRegistryLive } from "@lando/engine/providers/registry";
export {
  makeBootstrapLifecycleTracker,
  superviseBootstrapLayer,
} from "@lando/engine/runtime/bootstrap-lifecycle";
export {
  cliRuntimeOptions,
  effectiveBootstrapForCommand,
  resolveCliTelemetryState,
} from "@lando/engine/runtime/cli-options";
export { RuntimeCwd } from "@lando/engine/runtime/cwd";
export { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
export { installSignalHandlers } from "@lando/engine/runtime/interrupt";
export type { ManagedProviderMachineClassification } from "@lando/engine/runtime/managed-provider-machine";
export { normalizePluginPolicy } from "@lando/engine/runtime/runtime-options";
export type { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";
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
  ScratchInitAppPort,
} from "@lando/engine/scratch-app/service";
export { L337_BASE_DEFAULT_FEATURE_IDS } from "@lando/engine/services/base/l337";
export { LANDO_BASE_DEFAULT_FEATURE_IDS } from "@lando/engine/services/base/lando";
export { appSteps } from "@lando/engine/services/build-app-plan";
export { buildKeyForService } from "@lando/engine/services/build-key";
export { BuildOrchestratorLive } from "@lando/engine/services/build-orchestrator";
export { openScratchBuildResults, recordBuildResult } from "@lando/engine/services/build-results";
export {
  bundledFirstGlobalServiceLoader,
  makeBundledFirstGlobalServiceLoader,
} from "@lando/engine/services/bundled-global-service-loader";
export { CommandRegistryLive } from "@lando/engine/services/command-registry";
export { ConfigServiceLive } from "@lando/engine/services/config";
export { deterministicMetadata } from "@lando/engine/services/draft";
export {
  EventDispatchControl,
  EventRuntimeLive,
  EventServiceLive,
  makeEventRuntimeLive,
  makeEventServiceLive,
} from "@lando/engine/services/event-service";
export { composeService } from "@lando/engine/services/feature";
export type { BaseSeed, ComposeServiceInput } from "@lando/engine/services/feature";
export { FileSystemLive, writeAtomicFile } from "@lando/engine/services/file-system";
export {
  collectGlobalServiceContributions,
  defaultGlobalServiceModuleLoader,
  validateGlobalServiceContributions,
} from "@lando/engine/services/global-services";
export type {
  GlobalServiceModuleLoader,
  PendingGlobalServiceContribution,
} from "@lando/engine/services/global-services";
export {
  LandofileServiceLive,
  loadLandofileFile,
  makeBundledTemplateEngineRegistry,
  makeEngineLandofileServiceLive,
  renderLandofileTemplate,
  resolveLandofileIncludes,
} from "@lando/engine/services/landofile-live";
export { AppPlannerLive, FILE_SYNC_DEFAULT_EXCLUDES } from "@lando/engine/services/planner";
export {
  makeEnvSecretStore,
  makeEnvSecretStoreLive,
  SecretStoreLive,
} from "@lando/engine/services/secret-store";
export { makeShellRunnerLive } from "@lando/engine/services/shell-runner";
export { ProviderExecToolingEngineLive } from "@lando/engine/services/tooling-engine";
export { CertificateAuthorityUnavailableLive } from "@lando/engine/subsystems/certs/api";
export { HealthcheckRunnerUnavailableLive } from "@lando/engine/subsystems/healthcheck/api";
export { HealthcheckRunnerLive } from "@lando/engine/subsystems/healthcheck/live";
export { makeHealthcheckRunner } from "@lando/engine/subsystems/healthcheck/runner-factory";
export {
  HostProxyServiceDisabled,
  HostProxyServiceDisabledLive,
} from "@lando/engine/subsystems/host-proxy/api";
export { startDetachedHostProxyWorker } from "@lando/engine/subsystems/host-proxy/detached-worker";
export {
  dispatchRunLando,
  type HostProxyRunLandoExecutor,
  type HostProxyRunLandoExecutorInput,
} from "@lando/engine/subsystems/host-proxy/dispatch";
export { HOST_PROXY_RUN_LANDO_ENV_NAMES } from "@lando/engine/subsystems/host-proxy/session-env";
export { buildRunLandoRequest } from "@lando/engine/subsystems/host-proxy/shim";
export {
  createHostProxyRunLandoSession,
  HOST_PROXY_SHIM_SOURCE,
  hostProxyRunLandoStateDir,
  scopedHostProxyRunLandoSession,
  sendHostProxyRunLando,
  stripHostProxyRunLando,
} from "@lando/engine/subsystems/host-proxy/transport";
export { requestPathname } from "@lando/engine/subsystems/host-proxy/transport-response";
export {
  defaultHostProxyShimArtifactPath,
  resolveHostProxyShimArtifactPath,
} from "@lando/engine/subsystems/host-proxy/transport-shim";
export {
  hostProxyMountInfoFromPlan,
  hostProxyWorkerArgv,
  removeOwnedHostProxyWorkerState,
  startDetachedHostProxyWorker as startDetachedHostProxyWorkerProcess,
  terminateOwnedHostProxyWorker,
  terminateOwnedHostProxyWorkersInRoot,
  workerStatePath as hostProxyWorkerStatePath,
} from "@lando/engine/subsystems/host-proxy/worker";
export { defaultSpawnWorker } from "@lando/engine/subsystems/host-proxy/worker-process";
export {
  HOST_PROXY_WORKER_PROTOCOL_VERSION,
  probeWorker,
  readWorkerRecord,
  workerStatePath,
  writeWorkerRecord,
} from "@lando/engine/subsystems/host-proxy/worker-state";
export type { HostProxyWorkerRecord } from "@lando/engine/subsystems/host-proxy/worker-state";
export { readWorkerRecordStateAt } from "@lando/engine/subsystems/host-proxy/worker-state-file";
export { ProxyServiceUnavailableLive } from "@lando/engine/subsystems/proxy/api";
export {
  makeProxyServiceRegistry,
  makeProxyServiceRegistryLive,
  ProxyServiceRegistry,
  SelectedProxyServiceLive,
} from "@lando/engine/subsystems/proxy/registry";
export type { ProxyServiceRegistration } from "@lando/engine/subsystems/proxy/registry";
export { UrlScannerUnavailableLive } from "@lando/engine/subsystems/scanner/api";
export { SshServiceUnavailableLive } from "@lando/engine/subsystems/ssh/api";
export {
  recordUpdateOutcomeTelemetry,
  TELEMETRY_EVENT_INVENTORY,
  type UpdateOutcome,
  updateOutcomeFromError,
} from "@lando/telemetry/events";
export { CORE_VERSION } from "@lando/engine/version";
