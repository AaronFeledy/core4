import { mapFailures } from "@lando/sdk/command-result";
import { causeMessage } from "@lando/sdk/errors";
import { Schema } from "effect";

export class TempRootRetirementError extends Schema.TaggedError<TempRootRetirementError>()(
  "TempRootRetirementError",
  { target: Schema.String, message: Schema.String, remediation: Schema.String },
) {}

export const retirementError = (target: string, cause: unknown) =>
  new TempRootRetirementError({
    target,
    message: causeMessage(cause),
    remediation: "Preserve the temporary roots and inspect the reported endpoint and cleanup failures.",
  });

export const retirementFailures = (target: string) => mapFailures((cause) => retirementError(target, cause));
