import { Effect, Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class PortCollisionError extends Schema.TaggedError<PortCollisionError>()("PortCollisionError", {
  message: Schema.String,
  port: Schema.Number,
  apps: Schema.Array(Schema.Struct({ appId: Schema.String, service: Schema.String })),
  remediation: Remediation.pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Free the conflicting host port or change the published port mapping, then retry."),
    ),
  ),
}) {}

export class ScannerError extends Schema.TaggedError<ScannerError>()("ScannerError", {
  message: Schema.String,
  scannerId: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}
