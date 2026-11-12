import type { SchemaAST } from "effect";
import { SchemaIssue } from "effect";
import { isPlainRecord } from "../landofile/record.ts";
import {
  PLAIN_TEXT_SLOT_REJECTION,
  authoringExpectation,
  authoringSource,
  isExpressionSlot,
  throughSemanticSite,
} from "./authoring-issue-metadata.ts";
import { isMergeDirectiveMemberAst } from "./landofile-directive.ts";
import type { ValidationIssuePath } from "./validation-issue.ts";

export const valueAt = (root: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
  let current = root;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isPlainRecord(current) && typeof key === "string") current = current[key];
    else return undefined;
  }
  return current;
};

export const propertyKeyPath = (path: ReadonlyArray<unknown>): ValidationIssuePath =>
  path.map((segment) => (typeof segment === "number" ? segment : String(segment)));

export const propertyNames = (
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST> = new Set(),
): readonly string[] => {
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

export const expectationIssue = (ast: SchemaAST.AST, issue: SchemaIssue.Issue): SchemaIssue.Issue => {
  const source = authoringExpectation(ast);
  const options = { reportInput: SchemaIssue.hasInput(issue) };
  return source._tag === "Union"
    ? new SchemaIssue.AnyOf(source, [], issue.input, options)
    : new SchemaIssue.InvalidType(source, issue.input, options);
};

export const directiveIssue = (issue: SchemaIssue.Issue): boolean =>
  (issue._tag === "Composite" || issue._tag === "Encoding") && isMergeDirectiveMemberAst(issue.ast);

export const authoringNonCandidate = (wrapped: SchemaIssue.Issue): boolean => {
  const issue = throughSemanticSite(wrapped);
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

export const directivePayloadIssues = (issue: SchemaIssue.Issue): readonly SchemaIssue.Issue[] => {
  if (issue._tag === "Encoding") return directivePayloadIssues(issue.issue);
  if (issue._tag !== "Composite" || !isMergeDirectiveMemberAst(issue.ast)) return [issue];
  return issue.issues.map((child) => {
    if (child._tag !== "Pointer" || child.path[0] !== "value" || child.issue._tag === "MissingKey")
      return child;
    return child.path.length === 1 ? child.issue : new SchemaIssue.Pointer(child.path.slice(1), child.issue);
  });
};
