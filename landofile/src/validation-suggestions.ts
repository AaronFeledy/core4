import { expressionInterpolationsTouchOnlyScopes, parseExpressionEither } from "@lando/sdk/expressions";
import { composeTopLevelDispositions, isPlainRecord } from "@lando/sdk/landofile";
import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_TOP_LEVEL_KEYS,
  type SchemaIssueLeaf,
  ServiceConfig,
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssuePath,
  schemaIssueLeaves,
} from "@lando/sdk/schema";
import { Result, type SchemaIssue } from "effect";

const SERVICE_KEYS = [...Object.keys(ServiceConfig.fields), "working_dir", "env_file", "depends_on"];
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

export const valueAtPath = (value: unknown, path: ValidationIssuePath): unknown => {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isPlainRecord(current)) current = current[String(key)];
    else return undefined;
  }
  return current;
};

const plannerScopeSuggestion = (value: unknown, path: ValidationIssuePath): string | undefined => {
  const site = valueAtPath(value, path);
  if (typeof site !== "string" || !site.includes("{{")) return undefined;
  const parsed = parseExpressionEither(site, { filePath: "<landofile>", bareShellParameters: "preserve" });
  return Result.isSuccess(parsed) &&
    !expressionInterpolationsTouchOnlyScopes(parsed.success, ["recipe", "env"])
    ? "This value uses plan-time scopes (app, proxy, services), which resolve to text after validation. Use a literal or a recipe/env expression here."
    : undefined;
};

const composeSuggestedFix = (issue: SchemaIssueLeaf): string | undefined => {
  if (issue.path.length !== 1) return undefined;
  const key = String(issue.path[0]);
  switch (issue._tag) {
    case "Unexpected": {
      const disposition = composeTopLevelDispositions[key];
      if (disposition?.disposition === "rejected") return disposition.remediation;
      return isMisplacedComposeSurfaceKey(key) ? MISPLACED_COMPOSE_SURFACE_REMEDIATION[key] : undefined;
    }
    case "Type":
      if (issue.message.startsWith("Expected undefined")) return undefined;
      if (COMPOSE_TOP_LEVEL_KEYS.some((accepted) => accepted === key) || key.startsWith("x-")) {
        return `The top-level Compose key "${key}" is accepted, but this value does not match Lando's supported schema-backed subset. Use only the supported shape for ${key}.`;
      }
      if (COMPOSE_DEPRECATED_TOP_LEVEL_KEYS.some((deprecated) => deprecated === key)) {
        return `The top-level Compose key "${key}" is accepted only for compatibility and is ignored by Lando. Remove it from new Landofiles.`;
      }
      return undefined;
    case "Missing":
      return undefined;
    default:
      return issue._tag satisfies never;
  }
};

const suggestionForLeaf = (issue: SchemaIssueLeaf, parsed: unknown): string | undefined => {
  const path = issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
  const formatted = formatValidationIssuePath(path);
  const key = issue.path.at(-1);
  switch (issue._tag) {
    case "Unexpected":
      return (
        composeSuggestedFix(issue) ??
        issue.suggestion ??
        `Remove the unknown key${key === undefined ? "" : ` "${String(key)}"`}; it is not part of the canonical Landofile schema.`
      );
    case "Missing":
      return `Add the required "${key === undefined ? formatted : String(key)}" field.`;
    case "Type":
      return (
        plannerScopeSuggestion(parsed, path) ??
        (formatted === "sshAgent.socket"
          ? "Set sshAgent.socket to a string containing the host SSH-agent socket path, or omit it for automatic discovery."
          : undefined) ??
        composeSuggestedFix(issue)
      );
    default:
      return issue._tag satisfies never;
  }
};

export const landofileIssuesFromSchema = (
  issue: SchemaIssue.Issue,
  parsed: unknown,
): readonly ValidationIssue[] =>
  schemaIssueLeaves(issue, [], {
    extraAllowedKeys: (path) => (path[0] === "services" && path.length >= 3 ? SERVICE_KEYS : []),
  }).map((leaf) => {
    const suggestion = suggestionForLeaf(leaf, parsed);
    return {
      path: leaf.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
      message: leaf.message,
      ...(suggestion === undefined ? {} : { suggestion }),
    };
  });
