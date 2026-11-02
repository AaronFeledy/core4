import { Schema } from "effect";
import { ConfigExpressionError } from "./config.ts";
import {
  LandofileImportRefMisuseError,
  LandofileIncludeError,
  LandofileLoadLimitError,
  LandofileLoadOutsideRootError,
  LandofileLockMismatchError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
} from "./landofile.ts";

/** Independent failures encountered while assembling an authored Landofile. */
export const LandofileLoadFailure = Schema.Union([
  LandofileIncludeError,
  LandofileParseError,
  LandofileLockMismatchError,
  LandofileValidationError,
  LandofileLoadOutsideRootError,
  LandofileLoadLimitError,
  LandofileImportRefMisuseError,
  ConfigExpressionError,
  LandofileSandboxError,
  LandofileTimeoutError,
]);
export type LandofileLoadFailure = typeof LandofileLoadFailure.Type;

export class LandofileLoadError extends Schema.TaggedError<LandofileLoadError>()("LandofileLoadError", {
  message: Schema.String.annotate({ description: "Summary of every independent Landofile load failure." }),
  file: Schema.String.annotate({ description: "Root Landofile being assembled." }),
  failures: Schema.NonEmptyArray(LandofileLoadFailure).annotate({
    description: "Individual failures in deterministic load order, retaining their original diagnostics.",
  }),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).annotate({
    description: "Action required to correct the failed load.",
  }),
}) {}

export const landofileLoadFailures = (
  error: LandofileLoadFailure | LandofileLoadError,
): readonly LandofileLoadFailure[] => (error._tag === "LandofileLoadError" ? error.failures : [error]);
