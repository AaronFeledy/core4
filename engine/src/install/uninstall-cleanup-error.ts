import { Schema } from "effect";

export class UninstallResourceCleanupError extends Schema.TaggedError<UninstallResourceCleanupError>()(
  "UninstallResourceCleanupError",
  {
    message: Schema.String,
    removed: Schema.Array(Schema.String),
    retained: Schema.Array(Schema.String),
    failed: Schema.Array(Schema.String),
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const uninstallCleanupFailure = (message: string, cause?: unknown) =>
  new UninstallResourceCleanupError({
    message,
    removed: [],
    retained: [],
    failed: [message],
    remediation:
      "Preserve the managed runtime, machine and state. Inspect failed resources, recover their data and restore runtime access before retrying purge.",
    ...(cause === undefined ? {} : { cause }),
  });
