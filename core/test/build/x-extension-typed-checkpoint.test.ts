import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { evolveHistoricalAppMountAcceleration } from "./x-extension-app-mount-acceleration-proof.ts";
import {
  REVIEWED_COMPOSITE_EXPRESSION_PATTERN,
  REVIEWED_WHOLE_EXPRESSION_PATTERN,
  evolveHistoricalAuthoringProjection,
} from "./x-extension-authoring-projection-proof.ts";
import { loadNormalizedArtifact, repairClosedExtension, schemaAt } from "./x-extension-closed-record.ts";
import { evolveHistoricalConsolePort } from "./x-extension-console-port-proof.ts";
import { evolveHistoricalEndpointMetadata } from "./x-extension-endpoint-metadata-proof.ts";
import { evolveHistoricalEnvironment } from "./x-extension-environment-proof.ts";
import { evolveHistoricalNetworks } from "./x-extension-networks-proof.ts";
import { evolveHistoricalReadiness } from "./x-extension-readiness-proof.ts";
import { evolveHistoricalShorthand, shorthandDelta } from "./x-extension-shorthand-proof.ts";
import { evolveHistoricalTimestamps } from "./x-extension-timestamps-proof.ts";
import { typedBytes, typedCapture, typedCaptured } from "./x-extension-typed-checkpoint.ts";
import { TYPED_EXPRESSION_PATTERN, wireObject } from "./x-extension-wire-proof.ts";

const historicalExpected = evolveHistoricalConsolePort(
  evolveHistoricalAppMountAcceleration(
    evolveHistoricalEnvironment(
      evolveHistoricalEndpointMetadata(
        evolveHistoricalTimestamps(
          evolveHistoricalReadiness(
            evolveHistoricalShorthand(
              evolveHistoricalNetworks(
                normalizeJsonSchema(wireObject(repairClosedExtension(typedCaptured.services))),
                "authoring",
              ),
            ),
            "authoring",
          ),
          "authoring",
        ),
      ),
      "authoring",
    ),
  ),
);
const expected = evolveHistoricalAuthoringProjection(historicalExpected, "services");

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
    "composite-expression plain-text exclusion",
    (schema) => (schema.pattern === REVIEWED_COMPOSITE_EXPRESSION_PATTERN ? { type: "string" } : undefined),
  ],
  [
    "native init value type",
    (schema) =>
      isJsonObject(schema.properties) && isJsonObject(schema.properties.init)
        ? { ...schema, properties: { ...schema.properties, init: { type: "number" } } }
        : undefined,
  ],
  [
    "log-source timestamps value type",
    (schema) =>
      isJsonObject(schema.properties) && isJsonObject(schema.properties.timestamps)
        ? { ...schema, properties: { ...schema.properties, timestamps: { type: "number" } } }
        : undefined,
  ],
  [
    "whole-template expression grammar",
    (schema) =>
      schema.pattern === REVIEWED_WHOLE_EXPRESSION_PATTERN ? { ...schema, pattern: "^.*$" } : undefined,
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

test.each(["constrained", "moved"] as const)(
  "rejects an unreviewed %s historical expression node before replay",
  (mutation) => {
    const changed = mutateFirst(historicalExpected, (schema) =>
      schema.pattern === TYPED_EXPRESSION_PATTERN
        ? mutation === "constrained"
          ? { ...schema, minLength: 999 }
          : { type: "string", anyOf: [schema] }
        : undefined,
    );
    expect(changed).not.toBe(historicalExpected);
    expect(() => evolveHistoricalAuthoringProjection(wireObject(changed), "services")).toThrow(TypeError);
  },
);

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

test.each(["bare", "authoring"] as const)(
  "preserves unreviewed probe constraints during %s readiness evolution",
  (mode) => {
    const keys = shorthandDelta.healthcheckKeys;
    if (!Array.isArray(keys)) throw new TypeError("Missing historical probe keys");
    const properties: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("Invalid historical probe key");
      properties[key] = { type: "string" };
    }
    properties.kind = { type: "string", enum: ["command", "http", "none", "tcp"] };
    properties.intervalSeconds = { type: "number", minimum: 999 };
    properties.timeoutSeconds = { type: "number", maximum: 999 };
    properties.url = { type: "string", minLength: 999 };
    const probe = { type: "object", additionalProperties: false, minProperties: 1, properties };
    const historical = { properties: { healthcheck: probe, image: { type: "number" } } };
    const serialized = JSON.stringify(historical);

    const evolved = evolveHistoricalReadiness(historical, mode);

    for (const field of ["healthcheck", "readiness"]) {
      const object = schemaAt(evolved, `$.${field}`);
      if (!isJsonObject(object.properties)) throw new TypeError("Missing probe object");
      expect(object.minProperties).toBe(1);
      expect(object.properties.intervalSeconds).toEqual(properties.intervalSeconds);
      expect(object.properties.timeoutSeconds).toEqual(properties.timeoutSeconds);
      expect(object.properties.url).toEqual(properties.url);
    }
    expect(schemaAt(evolved, "$.image")).toEqual({ type: "number" });
    expect(JSON.stringify(historical)).toBe(serialized);
  },
);
