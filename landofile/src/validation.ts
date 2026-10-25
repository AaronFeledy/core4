import { LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { expressionInterpolationsTouchOnlyScopes, parseExpressionEither } from "@lando/sdk/expressions";
import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import {
  LandofileShape,
  ServiceConfig,
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssueLine,
  schemaIssueLeaves,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { getOrigins } from "./pipeline/origins.ts";
import { isValidSemverRange } from "./version-constraint.ts";

const SERVICE_KEYS = [...Object.keys(ServiceConfig.fields), "working_dir", "env_file", "depends_on"];
export const getLandofileValueSource = (value: object, path: ValidationIssuePath) => {
  const origins = getOrigins(value);
  return origins === undefined ? undefined : valueOriginAt(origins, path).source;
};
const COMPOSE_REMEDIATION =
  "Compose compatibility is limited to the supported subset; move provider-native keys under providers.<provider-id> or use config translation.";

const valueAtPath = (value: unknown, path: ValidationIssuePath): unknown => {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isPlainRecord(current)) current = current[String(key)];
    else return undefined;
  }
  return current;
};

export const plannerScopeSuggestion = (value: unknown, path: ValidationIssuePath): string | undefined => {
  const site = valueAtPath(value, path);
  if (typeof site !== "string" || !site.includes("{{")) return undefined;
  const parsed = parseExpressionEither(site, { filePath: "<landofile>", bareShellParameters: "preserve" });
  return Result.isSuccess(parsed) &&
    !expressionInterpolationsTouchOnlyScopes(parsed.success, ["recipe", "env"])
    ? "This value uses plan-time scopes (app, proxy, services), which resolve to text after validation. Use a literal or a recipe/env expression here."
    : undefined;
};

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
    message: `${framing.headline}: ${lines}${/[.?!]$/.test(lines) ? "" : "."} ${framing.remediation}`,
  });
};

export const validationErrorFromCause = (file: string, parsed: unknown, cause: unknown) => {
  const leaves = Schema.isSchemaError(cause) ? schemaIssueLeaves(cause.issue) : [];
  const unknown = leaves.filter((issue) => issue._tag === "Unexpected");
  const valuePaths = new Set(
    leaves.filter((issue) => issue._tag === "Type").map((issue) => JSON.stringify(issue.path)),
  );
  for (const issue of unknown) valuePaths.delete(JSON.stringify(issue.path));
  const issues = validationIssuesFromCause(cause, {
    fallback: "Invalid Landofile.",
    extraAllowedKeys: (path) => (path[0] === "services" && path.length >= 3 ? SERVICE_KEYS : []),
  }).map((issue) => {
    const suggestion =
      (valuePaths.has(JSON.stringify(issue.path)) ? plannerScopeSuggestion(parsed, issue.path) : undefined) ??
      issue.suggestion;
    const origins = isPlainRecord(parsed) ? getOrigins(parsed) : undefined;
    return {
      ...issue,
      ...(suggestion === undefined ? {} : { suggestion }),
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
