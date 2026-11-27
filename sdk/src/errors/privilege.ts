import { Schema } from "effect";

// Failures to obtain administrator privilege through `PrivilegeService`. A command that ran
// elevated and exited nonzero is a `ProcessResult`, never one of these.

const privilegeFields = {
  message: Schema.String,
  /** Human description of what needed administrator access. */
  purpose: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
} as const;

/** sudo needs a password, no `SUDO_ASKPASS` helper is set, and the run cannot prompt. */
export class PrivilegeCredentialsRequiredError extends Schema.TaggedError<PrivilegeCredentialsRequiredError>()(
  "PrivilegeCredentialsRequiredError",
  { ...privilegeFields },
) {}

/** sudo was asked for credentials and did not grant them. */
export class PrivilegeAuthorizationFailedError extends Schema.TaggedError<PrivilegeAuthorizationFailedError>()(
  "PrivilegeAuthorizationFailedError",
  { ...privilegeFields, exitCode: Schema.Number },
) {}

/** No elevation mechanism exists on this host (no sudo, or a platform without an adapter). */
export class PrivilegeUnavailableError extends Schema.TaggedError<PrivilegeUnavailableError>()(
  "PrivilegeUnavailableError",
  { ...privilegeFields, cause: Schema.optional(Schema.Unknown) },
) {}

export type PrivilegeError =
  | PrivilegeCredentialsRequiredError
  | PrivilegeAuthorizationFailedError
  | PrivilegeUnavailableError;
