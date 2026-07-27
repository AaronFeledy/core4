import { compareEnum } from "./enum-classifier.ts";
import {
  type CompatibilityException,
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  isJsonObject,
  jsonEquals,
  stringArray,
} from "./model.ts";

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

const finding = (
  verdict: CompatibilityFinding["verdict"],
  changeKind: string,
  path: string,
  message: string,
): CompatibilityFinding => ({ verdict, changeKind, path, message, accepted: false });

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
}

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

  for (const property of Object.keys(beforeProperties).sort()) {
    const propertyPath = childPath(context.path, property);
    const afterProperty = afterProperties[property];
    if (afterProperty === undefined) {
      findings.push(finding("breaking", "property-removed", propertyPath, "A public property was removed."));
      continue;
    }
    const beforeProperty = beforeProperties[property];
    if (beforeProperty !== undefined) {
      findings.push(...compareNode(beforeProperty, afterProperty, { ...context, path: propertyPath }));
    }
    if (beforeRequired.has(property) === afterRequired.has(property)) continue;
    if (afterRequired.has(property)) {
      const verdict = context.polarity === "output" ? "compatible" : "breaking";
      findings.push(
        finding(verdict, "property-required", propertyPath, "An optional property became required."),
      );
    } else {
      const verdict = context.polarity === "input" ? "compatible" : "breaking";
      findings.push(
        finding(verdict, "property-optional", propertyPath, "A required property became optional."),
      );
    }
  }

  for (const property of Object.keys(afterProperties).sort()) {
    if (beforeProperties[property] !== undefined) continue;
    const required = afterRequired.has(property);
    const verdict =
      context.polarity === "input" || context.polarity === "strict"
        ? required
          ? "breaking"
          : "compatible"
        : "compatible";
    findings.push(
      finding(
        verdict,
        "property-added",
        childPath(context.path, property),
        `A ${required ? "required" : "optional"} property was added.`,
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

  for (const keyword of UNSUPPORTED_CONSTRUCTS) {
    if (!jsonEquals(before[keyword], after[keyword])) {
      return [
        finding(
          "unknown",
          "unsupported-construct",
          childPath(context.path, keyword),
          `${keyword} changed and requires explicit review.`,
        ),
      ];
    }
  }
  if (!jsonEquals(before.$ref, after.$ref)) {
    return [
      finding("unknown", "ref-changed", childPath(context.path, "$ref"), "A JSON Schema reference changed."),
    ];
  }
  if (!jsonEquals(before.type, after.type)) {
    return [finding("breaking", "type-changed", context.path, "The JSON Schema type changed.")];
  }
  if (!jsonEquals(before.enum, after.enum)) {
    if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
      return [compareEnum(before.enum, after.enum, context)];
    }
    return [finding("breaking", "enum-changed", context.path, "An enum constraint was added or removed.")];
  }
  if (!jsonEquals(before.const, after.const)) {
    return [finding("breaking", "const-changed", context.path, "A constant value constraint changed.")];
  }

  const findings: CompatibilityFinding[] = [];
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
    findings.push(
      finding(
        "unknown",
        "unsupported-keyword",
        childPath(context.path, key),
        `${key} changed and is not classified by the conservative checker.`,
      ),
    );
  }
  return findings;
};

export const classifySchemaChange = (
  before: JsonSchema,
  after: JsonSchema,
  polarity: SchemaPolarity,
): ReadonlyArray<CompatibilityFinding> => compareNode(before, after, { polarity, path: "$" });

export const acceptCompatibilityExceptions = (
  surface: string,
  findings: ReadonlyArray<CompatibilityFinding>,
  exceptions: ReadonlyArray<CompatibilityException>,
): ReadonlyArray<CompatibilityFinding> =>
  findings.map((entry) => {
    const exception = exceptions.find(
      (candidate) =>
        candidate.surface === surface &&
        candidate.changeKind === entry.changeKind &&
        candidate.path === entry.path,
    );
    return exception === undefined
      ? entry
      : { ...entry, accepted: true, justification: exception.justification };
  });
