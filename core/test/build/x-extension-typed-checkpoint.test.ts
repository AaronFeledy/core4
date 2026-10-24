import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { loadNormalizedArtifact, repairClosedExtension, schemaAt } from "./x-extension-closed-record.ts";
import { evolveHistoricalEndpointMetadata } from "./x-extension-endpoint-metadata-proof.ts";
import { evolveHistoricalShorthand, shorthandDelta } from "./x-extension-shorthand-proof.ts";
import { evolveHistoricalTimestamps } from "./x-extension-timestamps-proof.ts";
import { typedBytes, typedCapture, typedCaptured } from "./x-extension-typed-checkpoint.ts";
import { TYPED_EXPRESSION_PATTERN, wireObject } from "./x-extension-wire-proof.ts";

const expected = evolveHistoricalEndpointMetadata(
  evolveHistoricalTimestamps(
    evolveHistoricalShorthand(normalizeJsonSchema(wireObject(repairClosedExtension(typedCaptured.services)))),
    "authoring",
  ),
);

const mutateFirst = (value: JsonValue, change: (schema: JsonSchema) => JsonSchema | undefined): JsonValue => {
  if (isJsonObject(value)) {
    const changed = change(value);
    if (changed !== undefined) return changed;
    for (const [key, child] of Object.entries(value)) {
      const next = mutateFirst(child, change);
      if (next !== child) return { ...value, [key]: next };
    }
  } else if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const next = mutateFirst(child, change);
      if (next !== child) return value.map((entry, position) => (position === index ? next : entry));
    }
  }
  return value;
};

test("pins the separate immutable typed-grammar checkpoint to its verified producer", () => {
  expect(typedCapture.provenanceCommit).toBe("614e804a9369ec2e6e751de16031f4cea8ee989d");
  const digest = createHash("sha256").update(typedBytes).digest("hex");
  expect(digest).toBe("a343c5de1e034ba4b9dbb5bfe8da1b5235be6a70d2d4ffd1dc5c06fe8d59cdb5");
  expect(typedCapture.sha256).toBe(digest);
});

const mutations: readonly [string, (schema: JsonSchema) => JsonSchema | undefined][] = [
  [
    "log-source timestamps value type",
    (schema) =>
      isJsonObject(schema.properties) && isJsonObject(schema.properties.timestamps)
        ? { ...schema, properties: { ...schema.properties, timestamps: { type: "number" } } }
        : undefined,
  ],
  [
    "whole-template expression grammar",
    (schema) => (schema.pattern === TYPED_EXPRESSION_PATTERN ? { ...schema, pattern: "^.*$" } : undefined),
  ],
  [
    "prototype-key rejection",
    (schema) =>
      isJsonObject(schema.propertyNames) &&
      isJsonObject(schema.propertyNames.not) &&
      schema.propertyNames.not.const === "__proto__"
        ? { ...schema, propertyNames: {} }
        : undefined,
  ],
  [
    "unrelated image value type",
    (schema) =>
      isJsonObject(schema.properties) && isJsonObject(schema.properties.image)
        ? { ...schema, properties: { ...schema.properties, image: { type: "number" } } }
        : undefined,
  ],
];

test("does not evolve a log-source object with an extra property", () => {
  // Given a closed object outside the exact reviewed historical key set.
  const historical = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      path: { type: "string" },
      stream: { type: "string" },
      extra: { type: "string" },
    },
  };
  // When the optional-field delta is replayed.
  const evolved = evolveHistoricalTimestamps(historical, "authoring");
  // Then the unrelated object stays unchanged, rather than gaining timestamps.
  expect(jsonEquals(evolved, normalizeJsonSchema(historical))).toBe(true);
});

test.each(mutations)(
  "rejects a current %s mutation after proving positive whole-subtree equality",
  async (_name, change) => {
    const current = schemaAt(
      await loadNormalizedArtifact("schema:ConfigTranslateEncodeInput"),
      "$.context.services",
    );
    expect(jsonEquals(expected, current)).toBe(true);
    const changed = mutateFirst(current, change);
    expect(changed).not.toBe(current);
    const mutated = normalizeJsonSchema(wireObject(changed));
    expect(jsonEquals(current, mutated)).toBe(false);
    expect(jsonEquals(expected, mutated)).toBe(false);
  },
  600_000,
);

test("does not discard an unexpected constraint while applying shell shorthand to typed grammar", () => {
  const keys = shorthandDelta.healthcheckKeys;
  if (!Array.isArray(keys)) throw new Error("Missing reviewed healthcheck keys");
  const properties: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("Invalid healthcheck key");
    properties[key] = { type: "string" };
  }
  const extra = { type: "string", pattern: TYPED_EXPRESSION_PATTERN, minLength: 999 };
  const evolved = evolveHistoricalShorthand({
    anyOf: [{ type: "object", additionalProperties: false, properties }, extra],
  });
  if (!Array.isArray(evolved.anyOf)) throw new Error("Expected evolved healthcheck union");
  expect(evolved.anyOf.some((member) => jsonEquals(member, extra))).toBe(true);
  expect(evolved.anyOf.some((member) => jsonEquals(member, { type: "string" }))).toBe(false);
});
