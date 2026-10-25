import { LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import {
  LandofileShape,
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssueLine,
  schemaIssueLeaves,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { getOrigins } from "./pipeline/origins.ts";
import { landofileIssuesFromSchema, valueAtPath } from "./validation-suggestions.ts";
import { isValidSemverRange } from "./version-constraint.ts";

export const getLandofileValueSource = (value: object, path: ValidationIssuePath) => {
  const origins = getOrigins(value);
  return origins === undefined ? undefined : valueOriginAt(origins, path).source;
};
const COMPOSE_REMEDIATION =
  "Compose compatibility is limited to the supported subset; move provider-native keys under providers.<provider-id> or use config translation.";

export const landofileValidationError = (
  file: string,
  issues: readonly ValidationIssue[],
  framing: { readonly headline: string; readonly remediation: string } = {
    headline: "Landofile has invalid values",
    remediation: "Fix each listed value.",
  },
): LandofileValidationError => {
  const lines = issues.map((issue) => formatValidationIssueLine(issue).replace(/\.$/, "")).join("; ");
  const source = issues[0]?.source;
  return new LandofileValidationError({
    file: source !== undefined && "file" in source ? source.file : file,
    issues,
    remediation: framing.remediation,
    message: `${framing.headline}: ${lines}${/[.?!]$/.test(lines) ? "" : "."}`,
  });
};

export const validationErrorFromCause = (file: string, parsed: unknown, cause: unknown) => {
  const leaves = Schema.isSchemaError(cause) ? schemaIssueLeaves(cause.issue) : [];
  const unknown = leaves.filter((issue) => issue._tag === "Unexpected");
  const issues = (
    Schema.isSchemaError(cause)
      ? landofileIssuesFromSchema(cause.issue, parsed)
      : validationIssuesFromCause(cause, { fallback: "Invalid Landofile." })
  ).map((issue) => {
    const origins = isPlainRecord(parsed) ? getOrigins(parsed) : undefined;
    return {
      ...issue,
      ...(origins === undefined ? {} : { source: valueOriginAt(origins, issue.path).source }),
    };
  });
  const hasValues = leaves.length === 0 || leaves.some((issue) => issue._tag !== "Unexpected");
  const compose = unknown.filter(
    (issue) =>
      issue.path[0] === "services" &&
      valueAtPath(parsed, ["services", String(issue.path[1]), "type"]) === "compose",
  );
  let headline = "Landofile contains unknown keys";
  if (unknown.length === 0) {
    headline = "Landofile has invalid values";
  } else if (hasValues) {
    headline = "Landofile has unknown keys and invalid values";
  } else if (compose.length === unknown.length) {
    headline = "Landofile contains unsupported Compose-subset keys";
  } else if (compose.length > 0) {
    headline = "Landofile contains unsupported service keys";
  }
  const remediation = [
    ...(unknown.length === 0 ? [] : ["Remove unknown keys or correct their spelling."]),
    ...(hasValues ? ["Fix each listed value."] : []),
    ...(compose.length === 0 ? [] : [COMPOSE_REMEDIATION]),
  ].join(" ");
  return landofileValidationError(file, issues, { headline, remediation });
};

export const validateLandofile = (
  file: string,
  parsed: unknown,
): Effect.Effect<typeof LandofileShape.Type, LandofileParseError | LandofileValidationError> => {
  const range = isPlainRecord(parsed) ? parsed.lando : undefined;
  if (typeof range === "string" && !isValidSemverRange(range)) {
    return Effect.fail(
      new LandofileParseError({
        message: `Landofile "lando:" is not a valid semver range: "${range}". Use npm semver syntax such as ">=4.1 <5", "^4", or "4.x".`,
        filePath: file,
        line: undefined,
        column: undefined,
      }),
    );
  }
  return Schema.decodeUnknownEffect(LandofileShape)(parsed, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(Effect.mapError((cause) => validationErrorFromCause(file, parsed, cause)));
};
