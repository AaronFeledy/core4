/**
 * Test helpers for the SDK provider and service contract suites.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
export { ContractFailure } from "./_shared.ts";
export { type PluginContractInput, TestPluginManifest } from "./plugin-contract.ts";
/**
 * runPluginContract arguments:
 * - manifest: decoded or encoded plugin manifest object to validate.
 * - layers: static Layer exports keyed by contribution kind (`provider`, `services`, etc.).
 * - globalServices: static global-service map keyed by contributed service id.
 * - serviceTypes: static service-type map keyed by contributed service type id.
 * - templateEngines: static template-engine map keyed by contributed engine id.
 */
export { runPluginContract } from "./plugin-contract.ts";
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
export * from "./service-contract.ts";
export * from "./file-sync-contract.ts";
export * from "./network-service-fixtures.ts";
export * from "./proxy-service-contract.ts";
export * from "./managed-file-contract.ts";
export * from "./remote-source-dataset-tunnel.ts";
export * from "./state-store-contract.ts";
export * from "./downloader-contract.ts";
export * from "./interaction-contract.ts";
export * from "./redaction-secret-store.ts";
export * from "./config-translator-route-filter.ts";
export * from "./doctor-tooling-plugin-source.ts";
export * from "./http-client-contract.ts";
export * from "./renderer-panel-protocol.ts";
export * from "./renderer-panel-contract.ts";
