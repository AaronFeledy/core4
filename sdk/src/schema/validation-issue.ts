import { Schema, type SchemaAST, SchemaIssue } from "effect";

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
export const ValidationIssue = Schema.Struct({
  path: ValidationIssuePath,
  message: Schema.String.annotate({ description: "Human-readable description of the problem." }),
  suggestion: Schema.optionalKey(Schema.String).annotate({
    description: "Likely fix, such as the closest allowed key for an unknown key.",
  }),
}).annotate({ identifier: "ValidationIssue" });
export type ValidationIssue = typeof ValidationIssue.Type;

const PATH_TEXT = /^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*)|\[\d+\])*$/;

/** Closest allowed key within Damerau-Levenshtein distance 2, or undefined. */
export const suggestionForUnknownKey = (
  unknownKey: string,
  allowedKeys: readonly string[],
): string | undefined => {
  let best: { readonly key: string; readonly distance: number } | undefined;
  for (const key of allowedKeys) {
    if (key === unknownKey) continue;
    const distance = damerauLevenshtein(unknownKey, key);
    if (distance > 2) continue;
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && key.localeCompare(best.key) < 0)
    ) {
      best = { key, distance };
    }
  }
  return best === undefined ? undefined : `Did you mean "${best.key}"?`;
};

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

/** A dotted or bracket path becomes that path; anything else is a root issue whose message is `message`. */
export const validationIssueFromText = (text: string, message: string): ValidationIssue => {
  const path = parseValidationIssuePath(text);
  return path === undefined ? { path: [], message } : { path, message };
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
  const suggestion = issue.suggestion === undefined ? "" : ` ${issue.suggestion}`;
  return where.length === 0 ? `${issue.message}${suggestion}` : `${where}: ${issue.message}${suggestion}`;
};

export interface SchemaValidationIssueOptions {
  readonly fallback?: string;
  readonly extraAllowedKeys?: (path: ValidationIssuePath) => readonly string[];
}

/** Standard Schema V1 path and message, plus a closest-key suggestion for unexpected keys. */
export const validationIssuesFromSchemaIssue = (
  issue: SchemaIssue.Issue,
  options?: SchemaValidationIssueOptions,
): readonly ValidationIssue[] => {
  const suggestions = unexpectedKeySuggestions(issue, [], options?.extraAllowedKeys);
  return SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues.map((formatted) => {
    const path = propertyKeyPath(formatted.path ?? []);
    const suggestion = suggestions.get(pathKey(path));
    return validationIssue(path, formatted.message, suggestion);
  });
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

const pathKey = (path: ValidationIssuePath): string => JSON.stringify(path);

const unexpectedKeySuggestions = (
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[],
  extraAllowedKeys: SchemaValidationIssueOptions["extraAllowedKeys"],
  suggestions: Map<string, string> = new Map(),
): Map<string, string> => {
  switch (issue._tag) {
    case "Pointer":
      return unexpectedKeySuggestions(issue.issue, [...path, ...issue.path], extraAllowedKeys, suggestions);
    case "Encoding":
      return unexpectedKeySuggestions(issue.issue, path, extraAllowedKeys, suggestions);
    case "Composite":
      for (const child of issue.issues) unexpectedKeySuggestions(child, path, extraAllowedKeys, suggestions);
      return suggestions;
    case "AnyOf":
      for (const child of issue.issues) unexpectedKeySuggestions(child, path, extraAllowedKeys, suggestions);
      return suggestions;
    case "Filter":
      if (SchemaIssue.defaultCheckHook(issue) === undefined && issue.issue._tag !== "InvalidValue") {
        return unexpectedKeySuggestions(issue.issue, path, extraAllowedKeys, suggestions);
      }
      return suggestions;
    case "UnexpectedKey": {
      const issuePath = propertyKeyPath(path);
      const unknownKey = issuePath.at(-1);
      if (typeof unknownKey !== "string") return suggestions;
      const allowed = [...propertyNames(issue.ast), ...(extraAllowedKeys?.(issuePath) ?? [])];
      const suggestion = suggestionForUnknownKey(unknownKey, allowed);
      if (suggestion !== undefined) suggestions.set(pathKey(issuePath), suggestion);
      return suggestions;
    }
    default:
      return suggestions;
  }
};

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

const damerauLevenshtein = (left: string, right: string): number => {
  const height = left.length + 1;
  const width = right.length + 1;
  const matrix = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  for (let row = 0; row < height; row += 1) {
    const line = matrix[row];
    if (line !== undefined) line[0] = row;
  }
  const header = matrix[0];
  if (header !== undefined) {
    for (let column = 0; column < width; column += 1) header[column] = column;
  }
  for (let row = 1; row < height; row += 1) {
    for (let column = 1; column < width; column += 1) {
      const current = matrix[row];
      const previous = matrix[row - 1];
      if (current === undefined || previous === undefined) continue;
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const deletion = (previous[column] ?? column) + 1;
      const insertion = (current[column - 1] ?? row) + 1;
      const substitution = (previous[column - 1] ?? 0) + cost;
      let best = Math.min(deletion, insertion, substitution);
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        const transposed = matrix[row - 2]?.[column - 2];
        if (transposed !== undefined) best = Math.min(best, transposed + 1);
      }
      current[column] = best;
    }
  }
  return matrix[left.length]?.[right.length] ?? Math.max(left.length, right.length);
};
