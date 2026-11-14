import { Schema, SchemaIssue } from "effect";
import { authoringSource, directiveValue, isSemanticSite } from "./authoring-issue-metadata.ts";
import { validationExpectation } from "./validation-expectation.ts";
import { schemaIssueKind } from "./validation-issue-kind.ts";
import {
  authoringNonCandidate,
  directiveIssue,
  directivePayloadIssues,
  expectationIssue,
  propertyKeyPath,
  propertyNames,
  valueAt,
} from "./validation-issue-projection.ts";
import { ValidationIssue, type ValidationIssuePath } from "./validation-issue-schema.ts";
import { suggestionForUnknownKey } from "./validation-key-suggestion.ts";
import { diagnosticUnionCandidates, selectByKeyPresence, unionValueMessage } from "./validation-union.ts";

export { ValidationIssue, ValidationIssuePath, ValidationIssueSource } from "./validation-issue-schema.ts";
export { closestKeys, suggestionForUnknownKey } from "./validation-key-suggestion.ts";

const PATH_TEXT = /^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*)|\[\d+\])*$/;

export const validationIssue = (
  path: ValidationIssuePath,
  message: string,
  suggestion?: string,
): ValidationIssue => (suggestion === undefined ? { path, message } : { path, message, suggestion });

/** Parse `services.web.ports[0].mode`. Prose returns undefined. */
export const parseValidationIssuePath = (text: string): ValidationIssuePath | undefined => {
  if (!PATH_TEXT.test(text)) return undefined;
  const path: Array<string | number> = [];
  for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)) {
    const key = match[1];
    const index = match[2];
    if (key !== undefined) path.push(key);
    else if (index !== undefined) path.push(Number(index));
  }
  return path;
};

/** `services.web.ports[0].mode`. Root is `""`. */
export const formatValidationIssuePath = (path: ValidationIssuePath): string => {
  let text = "";
  for (const segment of path) {
    text =
      typeof segment === "number"
        ? `${text}[${segment}]`
        : text.length === 0
          ? segment
          : `${text}.${segment}`;
  }
  return text;
};

/** One text line: `<path>: <message>`, root path with no prefix, suggestion on the same line. */
export const formatValidationIssueLine = (issue: ValidationIssue): string => {
  const where = formatValidationIssuePath(issue.path);
  const suggestion =
    issue.suggestion === undefined ? "" : `${/[.?!:]$/.test(issue.message) ? "" : "."} ${issue.suggestion}`;
  return where.length === 0 ? `${issue.message}${suggestion}` : `${where}: ${issue.message}${suggestion}`;
};

export interface SchemaValidationIssueOptions {
  readonly fallback?: string;
  readonly extraAllowedKeys?: (path: ValidationIssuePath) => readonly string[];
  /** The decoded input, used for union selection and JSON-kind classification. */
  readonly input?: unknown;
}

/** Diagnostic leaf retaining the issue category and Standard Schema property-key path. */
export const SchemaIssueLeaf = Schema.Struct({
  _tag: Schema.Literals(["Unexpected", "Missing", "Type"]),
  path: Schema.Array(Schema.PropertyKey),
  message: Schema.String,
  suggestion: Schema.optionalKey(Schema.String),
  kind: ValidationIssue.fields.kind,
});
export type SchemaIssueLeaf = typeof SchemaIssueLeaf.Type;

// Competing union members, or a property plus a matching pattern key, that report
// the same issue at the same path describe one defect.
const distinctLeaves = (leaves: ReadonlyArray<SchemaIssueLeaf>): ReadonlyArray<SchemaIssueLeaf> => {
  const seen = new Set<string>();
  return leaves.filter((leaf) => {
    const key = JSON.stringify([leaf._tag, leaf.path.map(String), leaf.message, leaf.suggestion, leaf.kind]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Flatten diagnostics, hiding authoring-only alternatives and synthetic directive payload paths. */
export const schemaIssueLeaves = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
  options?: SchemaValidationIssueOptions,
): ReadonlyArray<SchemaIssueLeaf> => {
  const walk = (child: SchemaIssue.Issue) => schemaIssueLeaves(child, path, options);
  const kind = schemaIssueKind(
    issue,
    options !== undefined && Object.hasOwn(options, "input")
      ? { input: valueAt(options.input, path) }
      : undefined,
  );
  const classification = kind === undefined ? {} : { kind };
  const unionLeaves = (children: readonly SchemaIssue.Issue[], candidateKind = kind) =>
    distinctLeaves(selectByKeyPresence(children, valueAt(options?.input, path)).flatMap(walk)).map((leaf) => {
      if (leaf.path.length !== path.length) return leaf;
      const { kind: _kind, ...rest } = leaf;
      return { ...rest, ...(candidateKind === undefined ? {} : { kind: candidateKind }) };
    });
  switch (issue._tag) {
    case "Pointer":
      return schemaIssueLeaves(issue.issue, [...path, ...issue.path], options);
    case "Encoding":
      return walk(issue.issue);
    case "Composite":
      return distinctLeaves(issue.issues.flatMap(walk));
    case "AnyOf": {
      const value = directiveValue(issue.ast);
      if (value !== undefined) {
        const directives = issue.issues.filter(directiveIssue);
        if (directives.length > 0) return directives.flatMap(directivePayloadIssues).flatMap(walk);
        const children = issue.issues.filter((child) => !authoringNonCandidate(child));
        return children.length === 0 ? walk(expectationIssue(value, issue)) : children.flatMap(walk);
      }
      if (authoringSource(issue.ast) !== undefined) {
        const children = issue.issues.filter((child) => !authoringNonCandidate(child));
        const candidates = diagnosticUnionCandidates(issue.ast, children);
        const message = unionValueMessage(issue.ast, candidates);
        if (message !== undefined) return [{ _tag: "Type", path, message, ...classification }];
        const attempted = new SchemaIssue.AnyOf(issue.ast, candidates, issue.input, {
          reportInput: SchemaIssue.hasInput(issue),
        });
        return candidates.length === 0
          ? walk(expectationIssue(issue.ast, issue))
          : unionLeaves(
              candidates,
              schemaIssueKind(
                attempted,
                options !== undefined && Object.hasOwn(options, "input")
                  ? { input: valueAt(options.input, path) }
                  : undefined,
              ),
            );
      }
      const message = unionValueMessage(issue.ast, issue.issues);
      if (message !== undefined) return [{ _tag: "Type", path, message, ...classification }];
      if (issue.issues.length > 0) return unionLeaves(issue.issues);
      break;
    }
    case "InvalidType":
      if (authoringSource(issue.ast) !== undefined) return walk(expectationIssue(issue.ast, issue));
      break;
    case "Filter":
      if (isSemanticSite(issue.filter)) return walk(issue.issue);
      if (SchemaIssue.defaultCheckHook(issue) === undefined && issue.issue._tag !== "InvalidValue") {
        return walk(issue.issue).map((leaf) => ({ ...leaf, kind: "value" }));
      }
      break;
    case "UnexpectedKey":
    case "MissingKey":
    case "InvalidValue":
    case "Forbidden":
    case "OneOf":
      break;
    default:
      return issue satisfies never;
  }
  const normalizedPath = propertyKeyPath(path);
  if (issue._tag === "InvalidType" || issue._tag === "AnyOf") {
    return [{ _tag: "Type", path, message: validationExpectation(issue.ast), ...classification }];
  }
  const unknownKey = normalizedPath.at(-1);
  const suggestion =
    issue._tag === "UnexpectedKey" && typeof unknownKey === "string"
      ? suggestionForUnknownKey(unknownKey, [
          ...propertyNames(issue.ast),
          ...(options?.extraAllowedKeys?.(normalizedPath) ?? []),
        ])
      : undefined;
  return SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues.map((formatted) => ({
    _tag: issue._tag === "UnexpectedKey" ? "Unexpected" : issue._tag === "MissingKey" ? "Missing" : "Type",
    path,
    message: formatted.message,
    ...classification,
    ...(suggestion === undefined ? {} : { suggestion }),
  }));
};

/** Standard Schema V1 path and message, plus a closest-key suggestion for unexpected keys. */
export const validationIssuesFromSchemaIssue = (
  issue: SchemaIssue.Issue,
  options?: SchemaValidationIssueOptions,
): readonly ValidationIssue[] => {
  return schemaIssueLeaves(issue, [], options).map(({ _tag, path, ...leaf }) => ({
    ...leaf,
    path: propertyKeyPath(path),
  }));
};

export const validationIssuesFromCause = (
  cause: unknown,
  options?: SchemaValidationIssueOptions,
): readonly ValidationIssue[] => {
  if (Schema.isSchemaError(cause)) return validationIssuesFromSchemaIssue(cause.issue, options);
  const message = cause instanceof Error ? cause.message : (options?.fallback ?? "Invalid value.");
  return [{ path: [], message }];
};
