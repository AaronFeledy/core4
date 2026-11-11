/**
 * Test helpers for the SDK provider and service contract suites.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
export { ContractFailure } from "./_shared.ts";
export * from "./ca-pem-fixture.ts";
export * from "./certificate-authority-contract.ts";
export * from "./certificate-fixtures.ts";
export * from "./config-translator-route-filter.ts";
export * from "./doctor-tooling-plugin-source.ts";
export * from "./downloader-contract.ts";
export * from "./file-sync-contract.ts";
export * from "./http-client-contract.ts";
/**
 * collectImportBoundaryViolations arguments:
 * - packageRoot: plugin package directory (has package.json + src/).
 * - sourceRoot / repoRoot / packageJson: optional fixture overrides.
 * - alwaysAllowed: defaults to @lando/sdk + @lando/container-runtime.
 * Parsing uses the TypeScript 6 compiler API, so install the optional
 * `@typescript/typescript6` peer dependency next to TypeScript 7.
 */
export {
  type CollectImportBoundaryViolationsOptions,
  type ImportBoundaryViolation,
  collectImportBoundaryViolations,
} from "./import-boundary.ts";
export * from "./interaction-contract.ts";
export * from "./managed-file-contract.ts";
export * from "./network-service-fixtures.ts";
/**
 * runPluginContract arguments:
 * - manifest: decoded or encoded plugin manifest object to validate.
 * - layers: static Layer exports keyed by contribution kind (`provider`, `services`, etc.).
 * - globalServices: static global-service map keyed by contributed service id.
 * - serviceTypes: static service-type map keyed by contributed service type id.
 * - templateEngines: static template-engine map keyed by contributed engine id.
 */
export { type PluginContractInput, TestPluginManifest, runPluginContract } from "./plugin-contract.ts";
export {
  type ContractMatrixCell,
  type ContractMatrixCellResult,
  type ContractMatrixOptions,
  type ContractMatrixReport,
  type HostPlatformId,
  type SupportedContractCell,
  type UnsupportedContractCell,
  runProviderContract,
  runProviderContractMatrix,
} from "./provider-contract.ts";
export * from "./provider-data-plane.ts";
export {
  type ProviderStartRetentionHooks,
  runProviderStartRetentionContract,
} from "./provider-start-retention.ts";
export { runProviderVolumeCreationContract } from "./provider-volume-creation.ts";
export * from "./recipe-decomposer.ts";
export * from "./redaction-secret-store.ts";
export * from "./remote-source-dataset-tunnel.ts";
export * from "./renderer-contract.ts";
export * from "./renderer-panel-contract.ts";
export * from "./renderer-panel-protocol.ts";
export * from "./router-service-contract.ts";
export * from "./service-contract.ts";
export * from "./state-store-contract.ts";
export { yamlRoundTripCorpus, yamlRoundTripRecord } from "./yaml-round-trip-corpus.ts";
