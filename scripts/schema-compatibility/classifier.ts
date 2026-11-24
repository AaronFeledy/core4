import { compareEnum } from "./enum-classifier.ts";
import { finding } from "./fingerprint.ts";
import {
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  isJsonObject,
  jsonEquals,
  stringArray,
} from "./model.ts";
import { normalizeJsonSchema } from "./normalize.ts";

export { acceptCompatibilityExceptions } from "./accept-exceptions.ts";

import { compareUnion, compareUnionReplacement } from "./union-classifier.ts";

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

const ANNOTATION_KEYS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "x-deprecation",
]);

const HANDLED_KEYS = new Set([
  "type",
  "properties",
  "required",
  "enum",
  "const",
  "items",
  "$defs",
  "$ref",
  ...UNSUPPORTED_CONSTRUCTS,
]);

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

const schemaMap = (value: JsonValue | undefined): Readonly<Record<string, JsonSchema>> | undefined => {
  if (!isJsonObject(value)) return undefined;
  const schemas: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(value)) {
    if (!isJsonObject(schema)) return undefined;
    schemas[name] = schema;
  }
  return schemas;
};

const requiredSet = (schema: JsonSchema): ReadonlySet<string> => new Set(stringArray(schema.required) ?? []);

interface CompareContext {
  readonly polarity: SchemaPolarity;
  readonly path: string;
  readonly unionProof?: boolean;
}

/** A property as its parent constrains it: its schema plus requiredness. */
const member = (schema: JsonSchema | undefined, required: boolean): JsonValue =>
  schema === undefined ? { required } : { required, schema };

const requirednessFinding = (
  path: string,
  change: { readonly before: JsonValue; readonly after: JsonValue; readonly nowRequired: boolean },
  polarity: CompareContext["polarity"],
): CompatibilityFinding =>
  change.nowRequired
    ? finding(
        polarity === "output" ? "compatible" : "breaking",
        "property-required",
        path,
        "An optional property became required.",
        change,
      )
    : finding(
        polarity === "input" ? "compatible" : "breaking",
        "property-optional",
        path,
        "A required property became optional.",
        change,
      );

const compareProperties = (
  before: JsonSchema,
  after: JsonSchema,
  context: CompareContext,
): ReadonlyArray<CompatibilityFinding> => {
  const beforeProperties = schemaMap(before.properties) ?? {};
  const afterProperties = schemaMap(after.properties) ?? {};
  const beforeRequired = requiredSet(before);
  const afterRequired = requiredSet(after);
  const findings: CompatibilityFinding[] = [];

  if (context.unionProof && [...afterRequired].some((name) => afterProperties[name] === undefined)) {
    return [
      finding(
        "unknown",
        "unsupported-construct",
        context.path,
        "Required keys without property schemas need explicit review.",
        { before, after },
      ),
    ];
  }

  for (const property of Object.keys(beforeProperties).sort()) {
    const propertyPath = childPath(context.path, property);
    const afterProperty = afterProperties[property];
    if (afterProperty === undefined) {
      findings.push(
        finding("breaking", "property-removed", propertyPath, "A public property was removed.", {
          before: member(beforeProperties[property], beforeRequired.has(property)),
        }),
      );
      continue;
    }
    const beforeProperty = beforeProperties[property];
    if (beforeProperty !== undefined) {
      findings.push(...compareNode(beforeProperty, afterProperty, { ...context, path: propertyPath }));
    }
    if (beforeRequired.has(property) !== afterRequired.has(property)) {
      findings.push(
        requirednessFinding(
          propertyPath,
          {
            before: member(beforeProperty, beforeRequired.has(property)),
            after: member(afterProperty, afterRequired.has(property)),
            nowRequired: afterRequired.has(property),
          },
          context.polarity,
        ),
      );
    }
  }

  // A required key may have no property schema; its requiredness still constrains the contract.
  for (const property of [...new Set([...beforeRequired, ...afterRequired])].sort()) {
    if (beforeProperties[property] !== undefined || afterProperties[property] !== undefined) continue;
    if (beforeRequired.has(property) === afterRequired.has(property)) continue;
    findings.push(
      requirednessFinding(
        childPath(context.path, property),
        {
          before: member(undefined, beforeRequired.has(property)),
          after: member(undefined, afterRequired.has(property)),
          nowRequired: afterRequired.has(property),
        },
        context.polarity,
      ),
    );
  }

  for (const property of Object.keys(afterProperties).sort()) {
    if (beforeProperties[property] !== undefined) continue;
    const required = afterRequired.has(property);
    const verdict =
      context.unionProof &&
      (context.polarity === "input" ||
        before.additionalProperties !== undefined ||
        before.unevaluatedProperties !== undefined)
        ? "unknown"
        : required && (context.polarity === "input" || context.polarity === "strict")
          ? "breaking"
          : "compatible";
    findings.push(
      finding(
        verdict,
        "property-added",
        childPath(context.path, property),
        `A ${required ? "required" : "optional"} property was added.`,
        { after: member(afterProperties[property], required) },
      ),
    );
  }
  return findings;
};

const compareDefinitions = (
  before: JsonSchema,
  after: JsonSchema,
  context: CompareContext,
): ReadonlyArray<CompatibilityFinding> => {
  const beforeDefinitions = schemaMap(before.$defs) ?? {};
  const afterDefinitions = schemaMap(after.$defs) ?? {};
  if (Object.keys(beforeDefinitions).sort().join("\0") !== Object.keys(afterDefinitions).sort().join("\0")) {
    return [
      finding(
        "unknown",
        "ref-graph-changed",
        childPath(context.path, "$defs"),
        "The local reference graph changed and cannot be classified safely.",
        { before: before.$defs, after: after.$defs },
      ),
    ];
  }
  return Object.keys(beforeDefinitions).flatMap((name) => {
    const beforeDefinition = beforeDefinitions[name];
    const afterDefinition = afterDefinitions[name];
    return beforeDefinition === undefined || afterDefinition === undefined
      ? []
      : compareNode(beforeDefinition, afterDefinition, {
          ...context,
          path: childPath(childPath(context.path, "$defs"), name),
        });
  });
};

const compareNode = (
  before: JsonSchema,
  after: JsonSchema,
  context: CompareContext,
): ReadonlyArray<CompatibilityFinding> => {
  if (jsonEquals(before, after)) return [];

  const replacement = compareUnionReplacement(before, after, {
    ...context,
    compare: (oldBranch, newBranch) => compareNode(oldBranch, newBranch, { ...context, unionProof: true }),
  });
  if (replacement !== undefined) return [replacement];

  const findings: CompatibilityFinding[] = [];
  for (const keyword of UNSUPPORTED_CONSTRUCTS) {
    if (!jsonEquals(before[keyword], after[keyword])) {
      const beforeMembers = before[keyword];
      const afterMembers = after[keyword];
      if (keyword === "anyOf" && Array.isArray(beforeMembers) && Array.isArray(afterMembers)) {
        const union = compareUnion(beforeMembers, afterMembers, {
          ...context,
          path: childPath(context.path, keyword),
        });
        if (union !== undefined) {
          findings.push(union);
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
  if (!jsonEquals(before.enum, after.enum)) {
    if (!Array.isArray(before.enum) || !Array.isArray(after.enum)) {
      return [
        ...findings,
        finding("breaking", "enum-changed", context.path, "An enum constraint was added or removed.", {
          before,
          after,
        }),
      ];
    }
    findings.push(compareEnum(before.enum, after.enum, context));
  }
  if (!jsonEquals(before.const, after.const)) {
    return [
      ...findings,
      finding("breaking", "const-changed", context.path, "A constant value constraint changed.", {
        before,
        after,
      }),
    ];
  }

  if (!jsonEquals(before.properties, after.properties) || !jsonEquals(before.required, after.required)) {
    findings.push(...compareProperties(before, after, context));
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
  if (!jsonEquals(before.$defs, after.$defs)) {
    findings.push(...compareDefinitions(before, after, context));
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (ANNOTATION_KEYS.has(key) || HANDLED_KEYS.has(key) || jsonEquals(before[key], after[key])) continue;
    if (key === "additionalProperties" && isJsonObject(before[key]) && isJsonObject(after[key])) {
      const nested = compareNode(before[key], after[key], { ...context, path: childPath(context.path, key) });
      if (nested.length > 0 && nested.every(({ changeKind }) => changeKind === "union-widened")) {
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
  polarity: SchemaPolarity,
): ReadonlyArray<CompatibilityFinding> =>
  jsonEquals(before, after)
    ? []
    : compareNode(normalizeJsonSchema(before), normalizeJsonSchema(after), { polarity, path: "$" });
