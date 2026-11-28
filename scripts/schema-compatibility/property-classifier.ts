import { finding } from "./fingerprint.ts";
import {
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  childPath,
  isJsonObject,
  stringArray,
} from "./model.ts";

const schemaMap = (value: JsonValue | undefined): Readonly<Record<string, JsonSchema>> | undefined => {
  if (!isJsonObject(value)) return undefined;
  const schemas: Record<string, JsonSchema> = Object.create(null);
  for (const [name, schema] of Object.entries(value)) {
    if (!isJsonObject(schema)) return undefined;
    schemas[name] = schema;
  }
  return schemas;
};

const requiredSet = (schema: JsonSchema): ReadonlySet<string> => new Set(stringArray(schema.required) ?? []);

interface PropertyContext {
  readonly polarity: SchemaPolarity;
  readonly path: string;
  readonly unionProof?: boolean;
  readonly compare: (before: JsonSchema, after: JsonSchema, path: string) => readonly CompatibilityFinding[];
}

const member = (schema: JsonSchema | undefined, required: boolean): JsonValue =>
  schema === undefined ? { required } : { required, schema };

const requirednessFinding = (
  path: string,
  change: { readonly before: JsonValue; readonly after: JsonValue; readonly nowRequired: boolean },
  polarity: SchemaPolarity,
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

const emptyProperties: Readonly<Record<string, JsonSchema>> = Object.create(null);

export const compareProperties = (
  before: JsonSchema,
  after: JsonSchema,
  context: PropertyContext,
): ReadonlyArray<CompatibilityFinding> => {
  const beforeProperties = schemaMap(before.properties) ?? emptyProperties;
  const afterProperties = schemaMap(after.properties) ?? emptyProperties;
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
      findings.push(...context.compare(beforeProperty, afterProperty, propertyPath));
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
