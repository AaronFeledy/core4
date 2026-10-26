import { Schema } from "effect";

export class ProxydBinaryNotFound extends Schema.TaggedError<ProxydBinaryNotFound>()("ProxydBinaryNotFound", {
  message: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export class ProxyElevationRefused extends Schema.TaggedError<ProxyElevationRefused>()(
  "ProxyElevationRefused",
  {
    message: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
