import { Schema } from "effect";

export class ContainerHelperUnavailableError extends Schema.TaggedError<ContainerHelperUnavailableError>()(
  "ContainerHelperUnavailableError",
  {
    target: Schema.Struct({
      os: Schema.Literal("linux"),
      arch: Schema.Literals(["x64", "arm64"]),
    }),
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    cause: Schema.optional(Schema.Unknown),
  },
) {}
