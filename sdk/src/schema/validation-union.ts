import type { SchemaAST, SchemaIssue } from "effect";
import { PLAIN_TEXT_SLOT_REJECTION, authoringSource } from "./authoring-issue-metadata.ts";

const candidateAst = (issue: SchemaIssue.Issue): SchemaAST.AST | undefined => {
  switch (issue._tag) {
    case "Encoding":
      return candidateAst(issue.issue);
    case "Composite":
    case "AnyOf":
    case "InvalidType":
      return issue.ast;
    default:
      return undefined;
  }
};

const rejectsDiscriminator = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "InvalidType":
    case "MissingKey":
      return true;
    case "InvalidValue":
      return issue.annotations?.[PLAIN_TEXT_SLOT_REJECTION] === true;
    case "Encoding":
      return rejectsDiscriminator(issue.issue);
    case "Composite":
    case "AnyOf":
      return issue.issues.every(rejectsDiscriminator);
    default:
      return false;
  }
};

const rejectsKey = (issue: SchemaIssue.Issue, key: PropertyKey): boolean => {
  switch (issue._tag) {
    case "Pointer":
      return issue.path[0] === key && rejectsDiscriminator(issue.issue);
    case "Encoding":
      return rejectsKey(issue.issue, key);
    case "Composite":
    case "AnyOf":
      return issue.issues.some((child) => rejectsKey(child, key));
    default:
      return false;
  }
};

const sentinelKeys = new WeakMap<SchemaAST.Union, readonly PropertyKey[]>();
const sourceMembers = new WeakMap<SchemaAST.Union, readonly SchemaAST.AST[]>();
const flattenMembers = (ast: SchemaAST.AST): readonly SchemaAST.AST[] =>
  ast._tag === "Union" ? ast.types.flatMap(flattenMembers) : [ast];
const flattenCandidates = (issue: SchemaIssue.Issue): readonly SchemaIssue.Issue[] =>
  issue._tag === "AnyOf" && authoringSource(issue.ast)?._tag === "Union"
    ? issue.issues.flatMap(flattenCandidates)
    : [issue];
const literalDiscriminator = (ast: SchemaAST.AST): boolean =>
  ast.context?.isOptional !== true &&
  (ast._tag === "Literal" ||
    ast._tag === "UniqueSymbol" ||
    (ast._tag === "Union" &&
      ast.types.length > 0 &&
      ast.types.every((member) => member._tag === "Literal" || member._tag === "UniqueSymbol")));

export const diagnosticUnionCandidates = (
  ast: SchemaAST.Union,
  children: readonly SchemaIssue.Issue[],
): readonly SchemaIssue.Issue[] => {
  const source = authoringSource(ast);
  if (source?._tag !== "Union") return children;
  let keys = sentinelKeys.get(source);
  if (keys === undefined) {
    const flattened = flattenMembers(source);
    sourceMembers.set(source, flattened);
    const members = flattened.filter((member) => member._tag === "Objects");
    const first = members[0];
    keys =
      first?._tag === "Objects"
        ? first.propertySignatures
            .filter((property) =>
              members.every(
                (member) =>
                  member._tag === "Objects" &&
                  member.propertySignatures.some(
                    (other) => other.name === property.name && literalDiscriminator(other.type),
                  ),
              ),
            )
            .map((property) => property.name)
        : [];
    sentinelKeys.set(source, keys);
  }
  if (keys.length === 0) return children;
  // Parsers omit input values from diagnostics. A surviving required source
  // sentinel is proved by the absence of its failure in exactly one candidate;
  // missing tags in partial fragments leave multiple candidates and stay partial.
  const members = sourceMembers.get(source) ?? [];
  const matches = children.flatMap(flattenCandidates).filter((child) => {
    const derived = candidateAst(child);
    return (
      derived !== undefined &&
      members.includes(authoringSource(derived) ?? derived) &&
      keys.every((key) => !rejectsKey(child, key))
    );
  });
  return matches.length === 1 ? matches : children;
};
