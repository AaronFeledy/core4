/** Public update operation contracts. */
export {
  UpdateChecksumSignatureVerificationError,
  UpdateChecksumVerificationError,
  UpdateDowngradeError,
  UpdateLaunchProbeError,
  UpdateManifestReplayError,
  UpdateMinimumVersionError,
  UpdateNetworkError,
  UpdatePermissionError,
  UpdateSignatureVerificationError,
} from "../update/errors.ts";
export type { UpdateError } from "../update/errors.ts";
export {
  defaultFetchManifestBytes,
  resolveUpdateManifestUrl,
  UpdateResultSchema,
  updateChannelForVersion,
} from "../update/manifest.ts";
export type { UpdateManifestFetcher } from "../update/manifest.ts";
export { makeUpdateHandoff } from "../update/handoff.ts";
export { checkCoreReplacement, guardCoreReplacement } from "../update/compatibility.ts";
export type { StoredUpdateResult, UpdateHandoff } from "../update/handoff.ts";
export { planUpdates } from "../update/plugin-plan.ts";
export type {
  AdvertisedPluginVersion,
  PlanUpdatesInput,
  PluginUpdateInventoryItem,
  PluginUpdateMetadata,
  PluginUpdatePlanRow,
  PluginUpdateReason,
  UpdatePlan,
  UpdatePlanRow,
  UpdateSelection,
} from "../update/plugin-plan.ts";
export { update } from "../update/operation.ts";
export type { UpdateOptions, UpdateResult } from "../update/operation.ts";
export type {
  PluginUpdateRunner,
  PluginUpdateRunInput,
  PluginUpdateRunResult,
} from "../update/operation.ts";
export type {
  UpdateExecve,
  UpdateExecveInput,
  UpdateRename,
  UpdateSelfUpdateOptions,
} from "../update/self-update.ts";
export type {
  UpdateChecksumSignatureInput,
  UpdateChecksumSignatureVerifier,
  UpdateManifestSignatureInput,
  UpdateManifestSignatureVerifier,
} from "../update/verify.ts";
export { buildWindowsReplacementScript, scheduleWindowsReplacement } from "../update/windows.ts";
export { runWindowsReplacementProcess } from "../update/windows-helper.ts";
export type {
  UpdateWindowsReplacement,
  UpdateWindowsReplacementInput,
  UpdateWindowsReplacementSpawnInput,
  UpdateWindowsReplacementSpawner,
} from "../update/windows.ts";
