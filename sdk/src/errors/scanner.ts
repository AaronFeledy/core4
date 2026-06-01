import { Schema } from "effect";

export class PortCollisionError extends Schema.TaggedError<PortCollisionError>()("PortCollisionError", {
  message: Schema.String,
  port: Schema.Number,
  apps: Schema.Array(Schema.Struct({ appId: Schema.String, service: Schema.String })),
}) {}

export class ScannerError extends Schema.TaggedError<ScannerError>()("ScannerError", {
  message: Schema.String,
  scannerId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
