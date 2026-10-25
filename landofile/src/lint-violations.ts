import { composeTopLevelDispositions } from "@lando/sdk/landofile";
import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_TOP_LEVEL_KEYS,
  type ConfigLintViolation,
  type SchemaIssueLeaf,
  ServiceConfig,
  type ValidationIssuePath,
  formatValidationIssuePath,
  parseValidationIssuePath,
  schemaIssueLeaves,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import type { SchemaIssue } from "effect";
import { Predicate } from "effect";
import type { ComposeRejectionMatch } from "./compose/rejections.ts";
import { plannerScopeSuggestion } from "./validation.ts";

const lastKey = (path: ReadonlyArray<PropertyKey>): string | undefined =>
  path.length === 0 ? undefined : String(path[path.length - 1]);
const MISPLACED_COMPOSE_SURFACE_REMEDIATION = {
  profiles:
    'The top-level key "profiles" is not a Compose top-level key; profiles is a service-level key. Split profile-specific config into separate Landofile fragments and select them with includes: instead.',
  extensions:
    'The top-level key "extensions" is not a Compose key. Use an x-* top-level extension or move provider-specific data under providers.<provider-id>.',
} as const;
const isMisplacedComposeSurfaceKey = (
  key: string,
): key is keyof typeof MISPLACED_COMPOSE_SURFACE_REMEDIATION =>
  Object.prototype.hasOwnProperty.call(MISPLACED_COMPOSE_SURFACE_REMEDIATION, key);
const composeSuggestedFix = (issue: SchemaIssueLeaf): string | undefined => {
  if (issue.path.length !== 1) return undefined;
  const key = String(issue.path[0]);
  if (issue._tag === "Unexpected") {
    const disposition = composeTopLevelDispositions[key];
    if (disposition?.disposition === "rejected") return disposition.remediation;
    return isMisplacedComposeSurfaceKey(key) ? MISPLACED_COMPOSE_SURFACE_REMEDIATION[key] : undefined;
  }
  if (issue._tag !== "Type" || issue.message.startsWith("Expected undefined")) return undefined;
  if (COMPOSE_TOP_LEVEL_KEYS.some((accepted) => accepted === key) || key.startsWith("x-")) {
    return `The top-level Compose key "${key}" is accepted, but this value does not match Lando's supported schema-backed subset. Use only the supported shape for ${key}.`;
  }
  if (COMPOSE_DEPRECATED_TOP_LEVEL_KEYS.some((deprecated) => deprecated === key)) {
    return `The top-level Compose key "${key}" is accepted only for compatibility and is ignored by Lando. Remove it from new Landofiles.`;
  }
  return undefined;
};
const pathFromText = (text: string): ValidationIssuePath => parseValidationIssuePath(text) ?? [];
const SERVICE_CONFIG_KEYS = [...Object.keys(ServiceConfig.fields), "working_dir", "env_file", "depends_on"];
const closestKeySuggestions = (issue: SchemaIssue.Issue): ReadonlyMap<string, string> =>
  new Map(
    validationIssuesFromSchemaIssue(issue, {
      extraAllowedKeys: (path) => (path[0] === "services" && path.length >= 3 ? SERVICE_CONFIG_KEYS : []),
    }).flatMap((entry) =>
      entry.suggestion === undefined
        ? []
        : [[formatValidationIssuePath(entry.path), entry.suggestion] as const],
    ),
  );
const violationFromIssue = (
  issue: SchemaIssueLeaf,
  suggestions: ReadonlyMap<string, string>,
): ConfigLintViolation => {
  const path = issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
  const formatted = formatValidationIssuePath(path);
  const key = lastKey(issue.path);
  const suggestion =
    (issue._tag === "Type" && formatted === "sshAgent.socket"
      ? "Set sshAgent.socket to a string containing the host SSH-agent socket path, or omit it for automatic discovery."
      : undefined) ??
    composeSuggestedFix(issue) ??
    (issue._tag === "Unexpected"
      ? (suggestions.get(formatted) ??
        `Remove the unknown key${key === undefined ? "" : ` "${key}"`}; it is not part of the canonical Landofile schema.`)
      : issue._tag === "Missing"
        ? `Add the required "${key ?? formatted}" field.`
        : undefined);
  return suggestion === undefined
    ? { rule: "landofile.validation", severity: "error", path, message: issue.message }
    : { rule: "landofile.validation", severity: "error", path, message: issue.message, suggestion };
};
export const rejectionViolation = (match: ComposeRejectionMatch): ConfigLintViolation => ({
  rule: "landofile.compose-rejection",
  severity: "error",
  path: pathFromText(match.documentPath),
  message: `Compose key "${match.matrixPath}" is rejected: ${match.rationale}`,
  suggestion: match.remediation,
});
const fallsWithinRejectedPath = (path: string, rejectedPath: string): boolean =>
  path === rejectedPath || path.startsWith(`${rejectedPath}.`) || path.startsWith(`${rejectedPath}[`);

export const violationsFromSchema = (
  issue: SchemaIssue.Issue,
  parsed: unknown,
  rejections: readonly ComposeRejectionMatch[] = [],
): readonly ConfigLintViolation[] => {
  const suggestions = closestKeySuggestions(issue);
  return schemaIssueLeaves(issue)
    .map((issue) => {
      const violation = violationFromIssue(issue, suggestions);
      const suggestion = issue._tag === "Type" ? plannerScopeSuggestion(parsed, violation.path) : undefined;
      return suggestion === undefined ? violation : { ...violation, suggestion };
    })
    .filter(
      (violation) =>
        !rejections.some((rejection) =>
          fallsWithinRejectedPath(formatValidationIssuePath(violation.path), rejection.documentPath),
        ),
    );
};

export const appNameOf = (parsed: unknown): string => {
  if (!Predicate.isObject(parsed)) return "";
  return typeof parsed.name === "string" ? parsed.name : "";
};
