import { Schema } from "effect";

/**
 * Manifest/host-resolution failure in the tool-provisioning helper: the active
 * host entry could not be resolved from a `ToolManifest`, or the manifest is
 * otherwise unusable (fail-closed when the host or artifact key is unsupported).
 */
export class ToolManifestError extends Schema.TaggedError<ToolManifestError>()("ToolManifestError", {
  message: Schema.String,
  toolId: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Archive extraction or binary install failure in the tool-provisioning helper:
 * the named member could not be extracted, or the verified bytes could not be
 * written into the install location.
 */
export class ToolExtractError extends Schema.TaggedError<ToolExtractError>()("ToolExtractError", {
  message: Schema.String,
  toolId: Schema.optional(Schema.String),
  member: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Containment failure in the tool-provisioning helper: the requested
 * `installName` resolves outside the realpath-contained `<userDataRoot>/bin/`
 * install root and is rejected before any bytes are written.
 */
export class ToolInstallPathError extends Schema.TaggedError<ToolInstallPathError>()("ToolInstallPathError", {
  message: Schema.String,
  toolId: Schema.optional(Schema.String),
  installName: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
