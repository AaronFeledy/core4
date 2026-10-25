import { Schema, type SchemaAST, SchemaIssue } from "effect";
import {
  PLAIN_TEXT_SLOT_REJECTION,
  authoringExpectation,
  authoringSource,
  directiveValue,
  isExpressionSlot,
} from "./authoring-issue-metadata.ts";
import { isMergeDirectiveMemberAst } from "./landofile-directive.ts";
import { LandofileLayer } from "./landofile-reference.ts";
import { validationExpectation } from "./validation-expectation.ts";
import { suggestionForUnknownKey } from "./validation-key-suggestion.ts";
import { diagnosticUnionCandidates } from "./validation-union.ts";

export { suggestionForUnknownKey } from "./validation-key-suggestion.ts";

/**
 * Location of a validation issue inside an authored document: object keys
 * as strings, array positions as numbers. The empty path is the document
 * root.
 */
export const ValidationIssuePath = Schema.Array(Schema.Union([Schema.String, Schema.Number])).annotate({
  description:
    "Location of the issue: object keys as strings, array positions as numbers. Empty for the document root.",
});
export type ValidationIssuePath = typeof ValidationIssuePath.Type;

/**
 * One problem found while validating an authored file (Landofile, include,
 * recipe manifest, global config). Every validator reports issues in this
 * shape, so text output, JSON envelopes, MCP results, editors, and Standard
 * Schema consumers agree on where a problem is and what it is.
 */
export const ValidationIssueSource = Schema.Union([
  Schema.Struct({
    file: Schema.String.annotate({ description: "Authored Landofile or fragment containing the value." }),
    layer: LandofileLayer.annotate({ description: "Root layer that contributed the authored value." }),
    path: ValidationIssuePath.annotate({
      description: "Original authored path before alias canonicalization or list relocation.",
    }),
  }),
  Schema.Struct({
    layer: Schema.Literals(["config-file", "config-drop-in"]),
    file: Schema.String,
    path: ValidationIssuePath,
  }),
  Schema.Struct({
    layer: Schema.Literal("env"),
    variable: Schema.String,
    path: ValidationIssuePath,
  }),
  Schema.Struct({ layer: Schema.Literal("host"), path: ValidationIssuePath }),
  Schema.Struct({ layer: Schema.Literal("default"), path: ValidationIssuePath }),
]);
export type ValidationIssueSource = typeof ValidationIssueSource.Type;

export const ValidationIssue = Schema.Struct({
  rule: Schema.optionalKey(Schema.String).annotate({
    description:
      "Stable diagnostic rule identifier, using the same identifiers as config lint when available.",
  }),
  path: ValidationIssuePath,
  message: Schema.String.annotate({ description: "Human-readable description of the problem." }),
  suggestion: Schema.optionalKey(Schema.String).annotate({
    description: "Likely fix, such as the closest allowed key for an unknown key.",
  }),
  source: Schema.optionalKey(ValidationIssueSource).annotate({
    description: "Physical source of the effective value, when known.",
  }),
}).annotate({ identifier: "ValidationIssue" });
export type ValidationIssue = typeof ValidationIssue.Type;

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
}

/** Diagnostic leaf retaining the issue category and Standard Schema property-key path. */
export const SchemaIssueLeaf = Schema.Struct({
  _tag: Schema.Literals(["Unexpected", "Missing", "Type"]),
  path: Schema.Array(Schema.PropertyKey),
  message: Schema.String,
  suggestion: Schema.optionalKey(Schema.String),
});
export type SchemaIssueLeaf = typeof SchemaIssueLeaf.Type;

const expectationIssue = (ast: SchemaAST.AST, issue: SchemaIssue.Issue): SchemaIssue.Issue => {
  const source = authoringExpectation(ast);
  const options = { reportInput: SchemaIssue.hasInput(issue) };
  return source._tag === "Union"
    ? new SchemaIssue.AnyOf(source, [], issue.input, options)
    : new SchemaIssue.InvalidType(source, issue.input, options);
};

const directiveIssue = (issue: SchemaIssue.Issue): boolean =>
  (issue._tag === "Composite" || issue._tag === "Encoding") && isMergeDirectiveMemberAst(issue.ast);

const authoringNonCandidate = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "InvalidValue":
      return issue.annotations?.[PLAIN_TEXT_SLOT_REJECTION] === true;
    case "InvalidType":
      return isExpressionSlot(issue.ast);
    case "Encoding":
      return (
        (isExpressionSlot(issue.ast) && issue.issue._tag === "InvalidType") ||
        authoringNonCandidate(issue.issue)
      );
    case "AnyOf": {
      const source = authoringSource(issue.ast);
      return (
        !(source?._tag === "Union" && source.types.every((member) => member._tag === "Literal")) &&
        (issue.issues.length > 0 || source !== undefined) &&
        issue.issues.every(authoringNonCandidate)
      );
    }
    default:
      return false;
  }
};

const directivePayloadIssues = (issue: SchemaIssue.Issue): readonly SchemaIssue.Issue[] => {
  if (issue._tag === "Encoding") return directivePayloadIssues(issue.issue);
  if (issue._tag !== "Composite" || !isMergeDirectiveMemberAst(issue.ast)) return [issue];
  return issue.issues.map((child) => {
    if (child._tag !== "Pointer" || child.path[0] !== "value" || child.issue._tag === "MissingKey") {
      return child;
    }
    return child.path.length === 1 ? child.issue : new SchemaIssue.Pointer(child.path.slice(1), child.issue);
  });
};

/** Flatten diagnostics, hiding authoring-only alternatives and synthetic directive payload paths. */
export const schemaIssueLeaves = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
  options?: SchemaValidationIssueOptions,
): ReadonlyArray<SchemaIssueLeaf> => {
  const walk = (child: SchemaIssue.Issue) => schemaIssueLeaves(child, path, options);
  switch (issue._tag) {
    case "Pointer":
      return schemaIssueLeaves(issue.issue, [...path, ...issue.path], options);
    case "Encoding":
      return walk(issue.issue);
    case "Composite":
      return issue.issues.flatMap(walk);
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
        return candidates.length === 0
          ? walk(expectationIssue(issue.ast, issue))
          : candidates.flatMap(walk);
      }
      if (issue.issues.length > 0) return issue.issues.flatMap(walk);
      break;
    }
    case "InvalidType":
      if (authoringSource(issue.ast) !== undefined) return walk(expectationIssue(issue.ast, issue));
      break;
    case "Filter":
      if (SchemaIssue.defaultCheckHook(issue) === undefined && issue.issue._tag !== "InvalidValue") {
        return walk(issue.issue);
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
    return [{ _tag: "Type", path, message: validationExpectation(issue.ast) }];
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
    ...(suggestion === undefined ? {} : { suggestion }),
  }));
};

/** Standard Schema V1 path and message, plus a closest-key suggestion for unexpected keys. */
export const validationIssuesFromSchemaIssue = (
  issue: SchemaIssue.Issue,
  options?: SchemaValidationIssueOptions,
): readonly ValidationIssue[] => {
  return schemaIssueLeaves(issue, [], options).map((leaf) =>
    validationIssue(propertyKeyPath(leaf.path), leaf.message, leaf.suggestion),
  );
};

export const validationIssuesFromCause = (
  cause: unknown,
  options?: SchemaValidationIssueOptions,
): readonly ValidationIssue[] => {
  if (Schema.isSchemaError(cause)) return validationIssuesFromSchemaIssue(cause.issue, options);
  const message = cause instanceof Error ? cause.message : (options?.fallback ?? "Invalid value.");
  return [{ path: [], message }];
};

const propertyKeyPath = (path: ReadonlyArray<unknown>): ValidationIssuePath =>
  path.map((segment) => (typeof segment === "number" ? segment : String(segment)));

const propertyNames = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): readonly string[] => {
  if (seen.has(ast)) return [];
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      return ast.propertySignatures.flatMap((signature) =>
        typeof signature.name === "string" ? [signature.name] : [],
      );
    case "Union":
      return ast.types.flatMap((type) => propertyNames(type, seen));
    case "Suspend":
      return propertyNames(ast.thunk(), seen);
    default:
      return [];
  }
};
