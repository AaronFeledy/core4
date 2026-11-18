import { dirname, isAbsolute, relative } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import {
  LandofileLayer,
  LandofileShape,
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssueLine,
  formatValidationIssuePath,
  schemaIssueLeaves,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import type { LandofileProvenance } from "./provenance.ts";
import { landofileIssuesFromSchema, valueAtPath } from "./validation-suggestions.ts";
import { isValidSemverRange } from "./version-constraint.ts";

export const getLandofileValueSource = (
  provenance: LandofileProvenance | undefined,
  path: ValidationIssuePath,
) => (provenance === undefined ? undefined : valueOriginAt(provenance.origins, path).source);
const COMPOSE_REMEDIATION =
  "Compose compatibility is limited to the supported subset; move provider-native keys under providers.<provider-id> or use config translation.";

const AUTHORED_LAYERS: ReadonlySet<string> = new Set(LandofileLayer.literals);

const isAuthoredSource = (issue: ValidationIssue): boolean =>
  issue.source === undefined || AUTHORED_LAYERS.has(issue.source.layer);

// Human-facing path only: structured source.file / error.file stay raw.
const isTerminalControl = (codePoint: number): boolean =>
  (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);

const escapeHumanPath = (path: string): string =>
  Array.from(path, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && isTerminalControl(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }).join("");

const displayPath = (file: string, appRoot: string): string => {
  const candidate = relative(appRoot, file);
  const shown = candidate.length === 0 || isAbsolute(candidate) ? file : candidate;
  return escapeHumanPath(shown);
};

const oneLine = (issue: ValidationIssue, appRoot: string): string => {
  const source = issue.source;
  if (source === undefined || !("file" in source) || isAuthoredSource(issue)) {
    return formatValidationIssueLine(issue);
  }
  const file = displayPath(source.file, appRoot);
  const location = formatValidationIssuePath(source.path);
  const where = formatValidationIssuePath(issue.path);
  const message = issue.message.replace(/\.$/u, "");
  const detail = `${where.length === 0 ? "" : `${where}: `}${message}`;
  const hint =
    issue.suggestion === undefined ? "" : `${/[.?!:]$/.test(message) ? "" : "."} ${issue.suggestion}`;
  return `${detail}${hint} (${file}${location.length === 0 ? "" : `: ${location}`})`;
};

const defaultHeadline = (issues: ReadonlyArray<ValidationIssue>, appRoot: string): string => {
  if (issues.every(isAuthoredSource)) return "Landofile has invalid values";

  const first = issues[0]?.source;
  if (first?.layer !== "project-file") return "Configuration has invalid values";
  let multipleFiles = false;
  for (const { source } of issues) {
    if (source?.layer !== "project-file") return "Configuration has invalid values";
    if (source.file !== first.file) multipleFiles = true;
  }
  return multipleFiles
    ? "Project files have invalid values"
    : `${displayPath(first.file, appRoot)} has invalid values`;
};

export const landofileValidationError = (
  file: string,
  issues: readonly ValidationIssue[],
  framing?: {
    readonly headline?: string;
    readonly remediation?: string;
    /** Canonical app root for human project-file paths. Defaults to dirname(file). */
    readonly appRoot?: string;
  },
): LandofileValidationError => {
  const appRoot = framing?.appRoot ?? dirname(file);
  const headline = framing?.headline ?? defaultHeadline(issues, appRoot);
  const remediation = framing?.remediation ?? "Fix each listed value.";
  const lines = issues.map((issue) => oneLine(issue, appRoot).replace(/\.$/, "")).join("; ");
  const source = issues[0]?.source;
  return new LandofileValidationError({
    file: source !== undefined && "file" in source ? source.file : file,
    issues,
    remediation,
    message: `${headline}: ${lines}${/[.?!]$/.test(lines) ? "" : "."}`,
  });
};

export const validationErrorFromCause = (
  file: string,
  parsed: unknown,
  cause: unknown,
  provenance?: LandofileProvenance,
) => {
  const leaves = Schema.isSchemaError(cause) ? schemaIssueLeaves(cause.issue, [], { input: parsed }) : [];
  const unknown = leaves.filter((issue) => issue._tag === "Unexpected");
  const origins = provenance === undefined ? undefined : provenance.origins;
  const issues = (
    Schema.isSchemaError(cause)
      ? landofileIssuesFromSchema(cause.issue, parsed)
      : validationIssuesFromCause(cause, { fallback: "Invalid Landofile." })
  ).map((issue) => ({
    ...issue,
    ...(origins === undefined ? {} : { source: valueOriginAt(origins, issue.path).source }),
  }));
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
  provenance?: LandofileProvenance,
): Effect.Effect<typeof LandofileShape.Type, LandofileParseError | LandofileValidationError> => {
  const range = isPlainRecord(parsed) ? parsed.lando : undefined;
  if (typeof range === "string" && !isValidSemverRange(range)) {
    return Effect.fail(
      new LandofileParseError({
        message: `Landofile "lando:" is not a valid semver range: "${range}". Use npm semver syntax such as ">=4.1 <5", "^4", or "4.x".`,
        filePath: file,
        line: undefined,
        column: undefined,
        remediation: `Edit the lando: field in ${file} to a valid npm semver range such as ">=4.1 <5", "^4", or "4.x".`,
      }),
    );
  }
  return Schema.decodeUnknownEffect(LandofileShape)(parsed, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(mapFailures((cause) => validationErrorFromCause(file, parsed, cause, provenance)));
};
