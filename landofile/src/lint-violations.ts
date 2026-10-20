import { composeTopLevelDispositions } from "@lando/sdk/landofile";
import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_TOP_LEVEL_KEYS,
  type ConfigLintViolation,
  LandofileShape,
  ServiceConfig,
  type ValidationIssuePath,
  formatValidationIssuePath,
  parseValidationIssuePath,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import type { SchemaIssue } from "effect";
import { Predicate, Result, Schema } from "effect";
import type { ComposeRejectionMatch } from "./compose/rejections.ts";
import { routeInputErrors } from "./route-normalize.ts";
import { type SchemaIssueLeaf, plannerScopeSuggestion, schemaIssueLeaves } from "./validation.ts";

const decodeLandofile = Schema.decodeUnknownResult(LandofileShape);
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
    ? { path, message: issue.message }
    : { path, message: issue.message, suggestion };
};
export const rejectionViolation = (match: ComposeRejectionMatch): ConfigLintViolation => ({
  path: pathFromText(match.documentPath),
  message: `Compose key "${match.matrixPath}" is rejected: ${match.rationale}`,
  suggestion: match.remediation,
});
const fallsWithinRejectedPath = (path: string, rejectedPath: string): boolean =>
  path === rejectedPath || path.startsWith(`${rejectedPath}.`) || path.startsWith(`${rejectedPath}[`);

export const routeViolations = (
  landofile: LandofileShape,
  options: { readonly deferExpressions: boolean },
): ReadonlyArray<ConfigLintViolation> =>
  [
    ...Object.entries(landofile.services ?? {}).map(([name, service]) => ({
      keyPath: `services.${name}.routes`,
      routes: service.routes ?? [],
    })),
    ...Object.entries(landofile.proxy ?? {}).map(([name, routes]) => ({ keyPath: `proxy.${name}`, routes })),
  ].flatMap(({ keyPath, routes }) =>
    routes.flatMap((route, index) => {
      const texts = typeof route === "string" ? [route] : [route.hostname, route.pathPrefix ?? ""];
      if (options.deferExpressions && texts.some((text) => text.includes("{{") || text.includes("${")))
        return [];
      return routeInputErrors(route, { keyPath: `${keyPath}[${index}]` }).map((error) => ({
        path: pathFromText(error.key),
        message: error.message,
        suggestion: error.remediation,
      }));
    }),
  );

export const violationsFor = (
  parsed: unknown,
  rejections: ReadonlyArray<ComposeRejectionMatch> = [],
): ReadonlyArray<ConfigLintViolation> => {
  const decoded = decodeLandofile(parsed, { onExcessProperty: "error", errors: "all" });
  if (Result.isSuccess(decoded)) {
    return routeViolations(decoded.success, { deferExpressions: true });
  }
  const suggestions = closestKeySuggestions(decoded.failure.issue);
  return schemaIssueLeaves(decoded.failure.issue)
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
