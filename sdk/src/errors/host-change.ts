import { Schema } from "effect";

// Failures to plan, approve, or apply a host change. Each names the changes it concerns and how to
// get past it; none carries file contents or secrets.

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

/** A required change has no approval and this run cannot ask for one. */
export class HostChangeConsentRequiredError extends Schema.TaggedError<HostChangeConsentRequiredError>()(
  "HostChangeConsentRequiredError",
  {
    message: Schema.String,
    remediation: Remediation,
    changeIds: Schema.Array(Schema.String),
    /** Setup flags that would approve the changes, such as `--yes` or `--enable-linger`. */
    flags: Schema.Array(Schema.String),
  },
) {}

/** The user answered no to a change setup cannot finish without. */
export class HostChangeDeclinedError extends Schema.TaggedError<HostChangeDeclinedError>()(
  "HostChangeDeclinedError",
  {
    message: Schema.String,
    remediation: Remediation,
    changeIds: Schema.Array(Schema.String),
  },
) {}

/** A declared step of an approved change failed, or the change did not take effect. */
export class HostChangeFailedError extends Schema.TaggedError<HostChangeFailedError>()(
  "HostChangeFailedError",
  {
    message: Schema.String,
    remediation: Remediation,
    changeId: Schema.String,
    stepId: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    /** Redacted before it is stored. */
    stderr: Schema.optional(Schema.String),
  },
) {}

/** The host no longer matches what the plan observed, so nothing of the change ran. */
export class HostChangeStaleError extends Schema.TaggedError<HostChangeStaleError>()("HostChangeStaleError", {
  message: Schema.String,
  remediation: Remediation,
  changeId: Schema.String,
  reason: Schema.String,
}) {}

/** A plugin declared an invalid change, or ran a step it did not declare. */
export class HostChangeContractError extends Schema.TaggedError<HostChangeContractError>()(
  "HostChangeContractError",
  {
    message: Schema.String,
    remediation: Remediation,
    owner: Schema.String,
    changeId: Schema.String,
    detail: Schema.String,
  },
) {}
