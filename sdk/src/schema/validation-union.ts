import { type SchemaAST, SchemaIssue } from "effect";
import { isPlainRecord } from "../landofile/record.ts";
import {
  PLAIN_TEXT_SLOT_REJECTION,
  authoringExpectation,
  authoringSource,
  isExpressionSlot,
} from "./authoring-issue-metadata.ts";
import { isMergeDirectiveMemberAst } from "./landofile-directive.ts";

const plainTextSlotRejection = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === "InvalidValue" && issue.annotations?.[PLAIN_TEXT_SLOT_REJECTION] === true;

// A key present where its member forbids it (`Never`), seen through authoring wrappers.
const forbiddenKeyIssue = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "Encoding":
      return forbiddenKeyIssue(issue.issue);
    case "AnyOf": {
      const real = issue.issues.filter((child) => !plainTextSlotRejection(child));
      if (real.length > 0) return real.every(forbiddenKeyIssue);
      // Never is never a union candidate, so a forbidden key under an authoring wrapper fails empty.
      const members = issue.ast.types.filter(
        (member) => !isMergeDirectiveMemberAst(member) && !isExpressionSlot(member),
      );
      return members.length > 0 && members.every((member) => member._tag === "Never");
    }
    case "InvalidType":
      return issue.ast._tag === "Never";
    default:
      return false;
  }
};
const keyPresencePointer = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === "Pointer" &&
  issue.path.length === 1 &&
  (issue.issue._tag === "MissingKey" || forbiddenKeyIssue(issue.issue));
// Partial fragments never report missing keys, so only a present forbidden key
// may rule a member out; otherwise fragment and effective would select differently.
const forbiddenKeyPointer = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === "Pointer" && issue.path.length === 1 && forbiddenKeyIssue(issue.issue);

// Field-level issues of a struct candidate, looking through authoring wrappers.
const fieldIssues = (issue: SchemaIssue.Issue): readonly SchemaIssue.Issue[] | undefined => {
  switch (issue._tag) {
    case "Encoding":
      return fieldIssues(issue.issue);
    case "Composite":
      return issue.ast._tag === "Objects" ? issue.issues : undefined;
    case "AnyOf": {
      const real = issue.issues.filter(
        (child) =>
          !(child._tag === "InvalidValue" && child.annotations?.[PLAIN_TEXT_SLOT_REJECTION] === true),
      );
      return real.length === 1 && real[0] !== undefined ? fieldIssues(real[0]) : undefined;
    }
    default:
      return undefined;
  }
};

// Whether the authored object could be this source member: its sentinels match,
// its required keys are present, and none of its forbidden (`Never`) keys are.
const fitsMember = (member: SchemaAST.AST, value: Readonly<Record<string, unknown>>): boolean => {
  switch (member._tag) {
    case "Objects":
      return member.propertySignatures.every(({ name, type }) => {
        if (typeof name !== "string") return true;
        const present = Object.hasOwn(value, name);
        if (type._tag === "Never") return !present;
        if (type.context?.isOptional === true) return true;
        if (!present) return false;
        return type._tag === "Literal" ? value[name] === type.literal : true;
      });
    case "Union":
      return member.types.some((type) => fitsMember(type, value));
    case "Suspend":
      return fitsMember(member.thunk(), value);
    default:
      return false;
  }
};

/**
 * Struct members told apart by which keys are present (each requires its own
 * key and forbids the others) have no literal sentinel. When exactly one
 * candidate fits the authored object, its issues are the whole story. Without
 * the authored value, a present forbidden key is the only evidence both partial
 * fragments and effective decodes share.
 */
export const selectByKeyPresence = (
  candidates: readonly SchemaIssue.Issue[],
  value?: unknown,
): readonly SchemaIssue.Issue[] => {
  if (candidates.length < 2) return candidates;
  if (isPlainRecord(value)) {
    const fitting = candidates.filter((candidate) => {
      const derived = candidateAst(candidate);
      return derived !== undefined && fitsMember(authoringSource(derived) ?? derived, value);
    });
    if (fitting.length === 1) return fitting;
  }
  const fields = candidates.map(fieldIssues);
  if (fields.some((issues) => issues === undefined)) return candidates;
  const matching = candidates.filter((_, index) => !fields[index]?.some(forbiddenKeyPointer));
  return matching.length === 1 ? matching : candidates;
};

// A union's message summarizes value-level or key-combination failures, but never
// hides a deeper location or a candidate's own explicit remediation.
export const unionValueMessage = (
  ast: SchemaAST.Union,
  candidates: readonly SchemaIssue.Issue[],
): string | undefined => {
  const source = authoringExpectation(ast);
  const message = source.annotations?.message;
  if (typeof message !== "string") return undefined;
  // Key presence only summarizes when several members compete for the input.
  const keyCombination = candidates.length > 1;
  const canSummarize = (issue: SchemaIssue.Issue): boolean => {
    switch (issue._tag) {
      case "Pointer":
        return (
          (keyCombination && keyPresencePointer(issue)) ||
          (issue.path.length === 0 && canSummarize(issue.issue))
        );
      case "Encoding":
        return canSummarize(issue.issue);
      case "Filter":
        return SchemaIssue.defaultCheckHook(issue) === undefined && canSummarize(issue.issue);
      case "Composite":
        return (
          typeof authoringExpectation(issue.ast).annotations?.message !== "string" &&
          issue.issues.every(canSummarize)
        );
      case "AnyOf":
        // Nested authoring unions drop the members the effective decode never tries.
        return (
          typeof authoringExpectation(issue.ast).annotations?.message !== "string" &&
          diagnosticUnionCandidates(
            issue.ast,
            issue.issues.filter((child) => !plainTextSlotRejection(child)),
          ).every(canSummarize)
        );
      case "InvalidType":
        return typeof authoringExpectation(issue.ast).annotations?.message !== "string";
      case "InvalidValue":
        return (
          issue.annotations?.[PLAIN_TEXT_SLOT_REJECTION] === true ||
          typeof issue.annotations?.message !== "string"
        );
      case "MissingKey":
      case "UnexpectedKey":
      case "Forbidden":
      case "OneOf":
        return false;
      default:
        return issue satisfies never;
    }
  };
  return candidates.every(canSummarize) ? message : undefined;
};

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
