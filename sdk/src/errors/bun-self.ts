import { Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class BunSelfReentryError extends Schema.TaggedError<BunSelfReentryError>()("BunSelfReentryError", {
  message: Schema.String,
  remediation: Remediation,
  execPath: Schema.String,
  verb: Schema.String,
  callerSubsystem: Schema.String,
}) {}

export class PluginPackageOperationError extends Schema.TaggedError<PluginPackageOperationError>()(
  "PluginPackageOperationError",
  {
    message: Schema.String,
    remediation: Remediation,
    commandId: Schema.String,
    operation: Schema.Literals(["resolve", "download", "verify", "extract", "postinstall", "remove"]),
    packageSpec: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    detail: Schema.optional(Schema.String),
  },
) {}
