import { finding } from "./fingerprint.ts";
import {
  type CompatibilityFinding,
  type JsonSchema,
  type SchemaPolarity,
  childPath,
  isJsonObject,
  jsonEquals,
} from "./model.ts";
import { normalizeJsonSchema } from "./normalize.ts";
import { compareProperties } from "./property-classifier.ts";
import { exactUnionChange, hasProofBarrier, proofBarrier, proveSetChange, setFinding } from "./set-proof.ts";
import { compareUnionReplacement } from "./union-classifier.ts";

export { acceptCompatibilityExceptions } from "./accept-exceptions.ts";

export type {
  CompatibilityException,
  CompatibilityFinding,
  JsonSchema,
  SchemaPolarity,
} from "./model.ts";

const UNSUPPORTED_CONSTRUCTS = [
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependencies",
] as const;

const HANDLED_KEYS = new Set([
  "type",
  "properties",
  "required",
  "enum",
  "const",
  "items",
  "$ref",
  ...UNSUPPORTED_CONSTRUCTS,
]);

interface CompareContext {
  readonly polarity: SchemaPolarity;
  readonly path: string;
  readonly unionProof?: boolean;
  readonly persisted?: boolean;
  readonly proofBlocked?: boolean;
}

const compareNode = (
  before: JsonSchema,
  after: JsonSchema,
  parent: CompareContext,
): ReadonlyArray<CompatibilityFinding> => {
  if (jsonEquals(before, after)) return [];

  const context = {
    ...parent,
    proofBlocked: parent.proofBlocked || hasProofBarrier(before) || hasProofBarrier(after),
  };
  if (!context.proofBlocked) {
    const proof = proveSetChange(before, after, context.path);
    // Keep the existing review identity for a strict change at the union itself.
    const strictUnion =
      !context.persisted &&
      context.polarity === "strict" &&
      proof?.some(({ path }) => path === childPath(context.path, "anyOf"));
    if (proof !== undefined && !strictUnion) {
      return proof.map((change) => setFinding(change, context));
    }
    if (!context.persisted) {
      const replacement = compareUnionReplacement(before, after, {
        ...context,
        compare: (oldBranch, newBranch) =>
          compareNode(oldBranch, newBranch, { ...context, unionProof: true }),
      });
      if (replacement !== undefined) return [replacement];
    }
  }

  const findings: CompatibilityFinding[] = [];
  for (const keyword of UNSUPPORTED_CONSTRUCTS) {
    if (!jsonEquals(before[keyword], after[keyword])) {
      const beforeMembers = before[keyword];
      const afterMembers = after[keyword];
      if (
        keyword === "anyOf" &&
        !context.persisted &&
        context.polarity !== "strict" &&
        !context.proofBlocked &&
        Array.isArray(beforeMembers) &&
        Array.isArray(afterMembers) &&
        !proofBarrier(beforeMembers) &&
        !proofBarrier(afterMembers)
      ) {
        const union = exactUnionChange(beforeMembers, afterMembers, childPath(context.path, keyword));
        if (union !== undefined) {
          findings.push(...union.map((change) => setFinding(change, context)));
          continue;
        }
      }
      return [
        ...findings,
        finding(
          "unknown",
          "unsupported-construct",
          childPath(context.path, keyword),
          `${keyword} changed and requires explicit review.`,
          // Later keywords of this node go unclassified, so bind the whole node.
          { before, after },
        ),
      ];
    }
  }
  if (!jsonEquals(before.$ref, after.$ref)) {
    return [
      ...findings,
      finding("unknown", "ref-changed", childPath(context.path, "$ref"), "A JSON Schema reference changed.", {
        before,
        after,
      }),
    ];
  }
  if (!jsonEquals(before.type, after.type)) {
    return [
      ...findings,
      finding("breaking", "type-changed", context.path, "The JSON Schema type changed.", { before, after }),
    ];
  }
  if (!jsonEquals(before.enum, after.enum) || !jsonEquals(before.const, after.const)) {
    return [
      ...findings,
      finding(
        "unknown",
        !jsonEquals(before.enum, after.enum) ? "enum-changed" : "const-changed",
        context.path,
        "The literal constraint changed without a set inclusion proof.",
        {
          before,
          after,
        },
      ),
    ];
  }

  if (!jsonEquals(before.properties, after.properties) || !jsonEquals(before.required, after.required)) {
    findings.push(
      ...compareProperties(before, after, {
        ...context,
        compare: (oldProperty, newProperty, path) =>
          compareNode(oldProperty, newProperty, { ...context, path }),
      }),
    );
  }
  if (!jsonEquals(before.items, after.items)) {
    if (isJsonObject(before.items) && isJsonObject(after.items)) {
      findings.push(
        ...compareNode(before.items, after.items, { ...context, path: childPath(context.path, "items") }),
      );
    } else {
      findings.push(
        finding(
          "unknown",
          "items-changed",
          childPath(context.path, "items"),
          "Array item structure changed.",
          { before: before.items, after: after.items },
        ),
      );
    }
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (HANDLED_KEYS.has(key) || jsonEquals(before[key], after[key])) continue;
    if (key === "additionalProperties" && isJsonObject(before[key]) && isJsonObject(after[key])) {
      const nested = compareNode(before[key], after[key], { ...context, path: childPath(context.path, key) });
      if (
        nested.length > 0 &&
        nested.every(({ changeKind, verdict }) => changeKind === "union-widened" && verdict !== "unknown")
      ) {
        findings.push(...nested);
        continue;
      }
    }
    if (
      context.unionProof &&
      key === "additionalProperties" &&
      ((context.polarity === "output" && before[key] === undefined) ||
        (context.polarity === "input" && after[key] === undefined))
    )
      continue;
    findings.push(
      finding(
        "unknown",
        "unsupported-keyword",
        childPath(context.path, key),
        `${key} changed and is not classified by the conservative checker.`,
        { before: before[key], after: after[key] },
      ),
    );
  }
  return findings;
};

export const classifySchemaChange = (
  before: JsonSchema,
  after: JsonSchema,
  policy: SchemaPolarity | { readonly polarity: SchemaPolarity; readonly persisted: boolean },
): ReadonlyArray<CompatibilityFinding> =>
  jsonEquals(before, after)
    ? []
    : [
        ...new Map(
          compareNode(normalizeJsonSchema(before), normalizeJsonSchema(after), {
            ...(typeof policy === "string" ? { polarity: policy } : policy),
            path: "$",
          }).map((entry) => [JSON.stringify([entry.path, entry.fingerprint]), entry]),
        ).values(),
      ];
