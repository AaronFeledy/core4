import { SchemaAST, SchemaIssue } from "effect";
import { authoringExpectation } from "./authoring-issue-metadata.ts";
import type { ValidationIssue } from "./validation-issue.ts";

const jsonKind = (value: unknown): string => {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
};

// Union dispatch can reject literals or discriminators without trying a member.
// Consult its encoded kinds only when the decoder supplied the actual input.
const acceptsKind = (
  schema: SchemaAST.AST,
  input: unknown,
  seen = new Set<SchemaAST.AST>(),
): boolean | undefined => {
  const ast = SchemaAST.toEncoded(authoringExpectation(schema));
  if (seen.has(ast)) return undefined;
  const visited = new Set([...seen, ast]);
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return typeof input === "string";
    case "Number":
      return typeof input === "number";
    case "Boolean":
      return typeof input === "boolean";
    case "Null":
      return input === null;
    case "Literal":
      return jsonKind(input) === jsonKind(ast.literal);
    case "Arrays":
      return Array.isArray(input);
    case "Objects":
      return input !== null && typeof input === "object" && !Array.isArray(input);
    case "ObjectKeyword":
      return input !== null && typeof input === "object";
    case "Union": {
      const accepted = ast.types.map((member) => acceptsKind(member, input, visited));
      if (accepted.includes(true)) return true;
      return accepted.includes(undefined) ? undefined : false;
    }
    case "Suspend":
      return acceptsKind(ast.thunk(), input, visited);
    case "Unknown":
    case "Any":
      return true;
    case "Never":
      return false;
    case "Undefined":
    case "Void":
      return input === undefined;
    case "BigInt":
      return typeof input === "bigint";
    case "Symbol":
    case "UniqueSymbol":
      return typeof input === "symbol";
    case "Enum":
      return ast.enums.some(([, value]) => jsonKind(value) === jsonKind(input));
    case "Declaration":
      return undefined;
    default:
      return ast satisfies never;
  }
};

export const schemaIssueKind = (
  issue: SchemaIssue.Issue,
  evidence?: { readonly input: unknown },
): ValidationIssue["kind"] => {
  const actual = SchemaIssue.hasInput(issue) ? { input: issue.input } : evidence;
  switch (issue._tag) {
    case "InvalidType":
      // A literal or enum member rejects a value of the right kind too; only the input can tell which.
      if (issue.ast._tag !== "Literal" && issue.ast._tag !== "Enum") return "type";
      if (actual === undefined) return undefined;
      return acceptsKind(issue.ast, actual.input) ? "value" : "type";
    case "Filter":
    case "InvalidValue":
    case "Forbidden":
    case "OneOf":
      return "value";
    case "UnexpectedKey":
      return "unexpected";
    case "MissingKey":
      return "missing";
    case "Encoding":
      return schemaIssueKind(issue.issue, actual);
    case "Pointer":
      return issue.path.length === 0 ? schemaIssueKind(issue.issue, actual) : "value";
    case "Composite": {
      const kinds = issue.issues.map((child) => schemaIssueKind(child, actual));
      if (kinds.every((kind) => kind === "type")) return "type";
      return kinds.includes(undefined) ? undefined : "value";
    }
    case "AnyOf": {
      if (actual !== undefined) {
        const accepted = acceptsKind(issue.ast, actual.input);
        if (accepted !== undefined) return accepted ? "value" : "type";
      }
      if (issue.issues.length === 0) return undefined;
      const kinds = issue.issues.map((child) => schemaIssueKind(child, actual));
      if (kinds.every((kind) => kind === "type")) return "type";
      return kinds.includes("value") ? "value" : undefined;
    }
    default:
      return issue satisfies never;
  }
};
