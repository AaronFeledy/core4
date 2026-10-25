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

// Mirrors Effect's union sentinels: a required immediate literal property of a
// struct, or a sentinel every member of a nested union shares.
type Sentinel = { readonly key: PropertyKey; readonly literal: unknown };
const sentinels = new WeakMap<SchemaAST.AST, readonly Sentinel[]>();
const sentinelsOf = (member: SchemaAST.AST): readonly Sentinel[] => {
  const cached = sentinels.get(member);
  if (cached !== undefined) return cached;
  sentinels.set(member, []);
  let found: readonly Sentinel[] = [];
  if (member._tag === "Objects") {
    found = member.propertySignatures.flatMap(({ name, type }): Sentinel[] =>
      type.context?.isOptional === true
        ? []
        : type._tag === "Literal"
          ? [{ key: name, literal: type.literal }]
          : type._tag === "UniqueSymbol"
            ? [{ key: name, literal: type.symbol }]
            : [],
    );
  } else if (member._tag === "Union" && member.types.length > 0) {
    const [first = [], ...rest] = member.types.map(sentinelsOf);
    found = first.filter((sentinel) =>
      rest.every((others) => others.some((o) => o.key === sentinel.key && o.literal === sentinel.literal)),
    );
  } else if (member._tag === "Suspend") {
    found = sentinelsOf(member.thunk());
  }
  sentinels.set(member, found);
  return found;
};

const isLiteral = (ast: SchemaAST.AST): boolean => ast._tag === "Literal" || ast._tag === "UniqueSymbol";

/**
 * Derivation strips literal sentinels and turns literals into expression-capable
 * unions, so every union member becomes a candidate. Keep only what the
 * effective decode would have tried: Effect tries a literal member only on an
 * exact match, and never tries a member whose required literal property
 * rejects the input. An empty result means no member matched, and the caller
 * reports the union expectation.
 */
export const diagnosticUnionCandidates = (
  ast: SchemaAST.Union,
  children: readonly SchemaIssue.Issue[],
): readonly SchemaIssue.Issue[] => {
  const source = authoringSource(ast);
  if (source?._tag !== "Union") return children;
  // Nested AnyOfs with the same source are derivation wrappers, not source members.
  const unwrap = (issue: SchemaIssue.Issue): readonly SchemaIssue.Issue[] =>
    issue._tag === "AnyOf" && authoringSource(issue.ast) === source ? issue.issues.flatMap(unwrap) : [issue];
  return children.flatMap(unwrap).filter((child) => {
    const derived = candidateAst(child);
    if (derived === undefined) return true;
    const member = authoringSource(derived) ?? derived;
    if (isLiteral(member)) return !rejectsDiscriminator(child);
    const keys = sentinelsOf(member).map(({ key }) => key);
    // Effect never tries a discriminated member for non-object input or a mismatched tag.
    return keys.length === 0 || !(rejectsDiscriminator(child) || keys.some((key) => rejectsKey(child, key)));
  });
};
