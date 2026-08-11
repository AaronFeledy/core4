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
export { update } from "../update/operation.ts";
export type { UpdateOptions, UpdateResult } from "../update/operation.ts";
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
export type {
  UpdateWindowsReplacement,
  UpdateWindowsReplacementInput,
  UpdateWindowsReplacementSpawnInput,
  UpdateWindowsReplacementSpawner,
} from "../update/windows.ts";
