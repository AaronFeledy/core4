import { type SchemaAST as AST, Predicate } from "effect";
import { isLandofileOverride, isLandofileReset } from "../landofile/merge-directives.ts";

// ==== Explicit proofs for checks that can run with an uncertain sibling.
/** Top-level properties read by a check; all must decode before the check runs. */
export const AUTHORING_READS = "lando/authoring/reads";
/** A violation on any decoded subset proves a violation on the full record. */
export const AUTHORING_SUBSET_SAFE = "lando/authoring/subset-safe";

export const authoringReads = (check: AST.Filter<unknown>): readonly string[] | undefined => {
  const reads = check.annotations?.[AUTHORING_READS];
  return Array.isArray(reads) && reads.every((key): key is string => typeof key === "string")
    ? reads
    : undefined;
};

export const authoringSubsetSafe = (check: AST.Filter<unknown>): boolean =>
  check.annotations?.[AUTHORING_SUBSET_SAFE] === true;

export const containsAuthoringExpression = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsAuthoringExpression);
  if (!Predicate.isObject(value)) return false;
  if ("_tag" in value && value._tag === "AuthoringExpression") return true;
  return Object.values(value).some(containsAuthoringExpression);
};

/** Copy native directives into the value the runtime will observe, without resolving expressions. */
export const projectAuthoringValue = (value: unknown): unknown => {
  if (isLandofileOverride(value)) return projectAuthoringValue(value.value);
  if (Array.isArray(value)) return value.map(projectAuthoringValue);
  if (!Predicate.isObject(value)) return value;
  if ("_tag" in value && value._tag === "AuthoringExpression") return value;
  return Object.fromEntries(
    Reflect.ownKeys(value)
      .filter((key) => !isLandofileReset(Reflect.get(value, key)))
      .map((key) => [key, projectAuthoringValue(Reflect.get(value, key))]),
  );
};
