import { describe, expect, test } from "bun:test";
import {
  JSON_SCHEMA_NAMES,
  ServiceConfig,
  getJsonSchema,
  validatePublicSchemaAnnotations,
} from "@lando/sdk/schema";
import { Schema } from "effect";

describe("authoring JSON Schema publication", () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "preserves non-JSON runtime numbers in maps: %s",
    (value) => {
      // Given values accepted by the runtime number schema but not representable as JSON numbers.
      const input = { sysctls: { key: value }, environment: { KEY: value }, labels: { key: value } };
      // When decoded through the runtime service contract.
      const decoded = Schema.decodeUnknownSync(ServiceConfig)(input);
      // Then JSON-only projection constraints do not narrow runtime acceptance.
      expect(decoded.sysctls?.key).toBe(value);
      expect(decoded.environment?.KEY).toBe(String(value));
      expect(decoded.labels?.key).toBe(String(value));
    },
  );
  test.each([
    ["environment", '{"__proto__":"value"}'],
    ["labels", '{"__proto__":"value"}'],
    ["dependsOn", '{"__proto__":{"condition":"service_started"}}'],
    ["sysctls", '{"__proto__":{"nested":true}}'],
    ["extra_hosts", '{"__proto__":{"nested":true}}'],
    ["environment", '{"__proto__":{"nested":true}}'],
    ["labels", '{"__proto__":{"nested":true}}'],
    ["dependsOn", '{"__proto__":{"condition":false}}'],
    ["environment", '{"invalid":{},"__proto__":{"nested":true}}'],
  ])("rejects JSON-owned reserved keys in %s", (field, json) => {
    // Given an own reserved property from JSON, not a prototype-setting literal.
    const value: unknown = JSON.parse(json);
    // When it crosses the service boundary.
    const decode = () => Schema.decodeUnknownSync(ServiceConfig)({ [field]: value });
    // Then the existing reserved-key remediation remains intact.
    expect(decode).toThrow(
      'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
    );
  });

  test.each(["environment", "labels"] as const)("rejects nested values in %s maps", (field) => {
    // Given a non-scalar map value outside both accepted input forms.
    const input = { [field]: { nested: {} } };
    // When it crosses the service boundary.
    const decode = () => Schema.decodeUnknownSync(ServiceConfig)(input);
    // Then using a native record does not widen acceptance.
    expect(decode).toThrow();
  });
  test("publishes reserved dependency map keys when projecting service inputs", () => {
    // Given the existing dependency map guard.
    // When its authoring artifact is projected.
    const schema = getJsonSchema("ServiceConfigInput");
    // Then the map branch excludes the same reserved key as runtime decoding.
    expect(schema).toHaveProperty(
      "properties.dependsOn.anyOf",
      expect.arrayContaining([
        expect.objectContaining({ type: "object", propertyNames: { not: { const: "__proto__" } } }),
      ]),
    );
  });
  test.each([
    ["sysctls", [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }]],
    ["environment", [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }]],
    ["labels", [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }]],
    ["extra_hosts", [{ type: "string" }, { type: "array", items: { type: "string" } }]],
  ])("publishes the bounded map branch when projecting %s", (field, values) => {
    // Given a Compose field accepting maps and string-list shorthand.
    // When the public encoded service schema is emitted.
    const schema = getJsonSchema("ServiceConfigInput");
    // Then the map branch retains the base contract, rather than accepting every JSON value.
    expect(schema).toHaveProperty(`properties.${field}.anyOf`, [
      {
        type: "object",
        additionalProperties: { anyOf: values },
        propertyNames: { not: { const: "__proto__" } },
      },
      { type: "array", items: { type: "string" } },
    ]);
  });

  test.each(["AppEnvironmentDefaults", "AppLabelDefaults"] as const)(
    "keeps string map constraints when projecting %s",
    (name) => {
      // Given a runtime-bounded default map.
      // When its public artifact is emitted.
      const schema = getJsonSchema(name);
      // Then both the native map and the existing entry bound survive.
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: { type: "string" },
        maxProperties: 256,
      });
    },
  );

  test("keeps optional agent settings when using native object projection", () => {
    // Given the optional agent environment configuration.
    // When its artifact is emitted without a parallel handwritten schema.
    const schema = getJsonSchema("AgentEnvConfig");
    // Then field types, defaults, and closed-object semantics remain intact.
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        allow: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
      },
    });
    expect(schema).not.toHaveProperty("required");
  });

  test("retains recursive call expressions when publishing authoring expressions", () => {
    // Given the recursive expression contract used by authoring placeholders.
    // When its public artifact is emitted.
    const schema = getJsonSchema("AuthoringExpression");
    // Then function calls retain their callee and recursive argument graph.
    const { definitions } = Schema.decodeUnknownSync(
      Schema.Struct({ definitions: Schema.Record(Schema.String, Schema.Unknown) }),
    )(schema);
    expect(Object.values(definitions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                kind: { type: "string", enum: ["Call"] },
                callee: { type: "string" },
                args: {
                  type: "array",
                  items: { $ref: expect.stringMatching(/^#\/definitions\/ExpressionNode/) },
                },
              }),
            }),
          ]),
        }),
      ]),
    );
  });

  test.each(["VerifyProps", "InspectProps", "ScenarioProps", "GuideFrontmatter"] as const)(
    "retains object fields when approximating cross-field checks in %s",
    (name) => {
      // Given checks whose cross-field predicates are not part of the published projection.
      // When their public artifact is emitted.
      const schema = getJsonSchema(name);
      // Then approximation omits only the predicate, not the underlying object graph.
      expect(schema).toMatchObject({ type: "object", properties: expect.any(Object) });
    },
  );

  test("publishes router and fragment definitions when requesting the authoring fragment", () => {
    // Given an expression-aware recursive fragment contract.
    const name = "LandofileAuthoringFragment";
    // When its public artifact is emitted.
    const schema = getJsonSchema(name);
    // Then the object member keeps its properties and fragment-specific definitions survive publication.
    expect(schema).toHaveProperty(
      "anyOf",
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({ router: expect.anything() }),
        }),
      ]),
    );
    expect(schema).toHaveProperty("definitions.ServiceConfigInputAuthoringFragment");
    expect(schema).not.toHaveProperty("definitions.ServiceConfigInput");
  });

  test("keeps complete and partial definitions distinct when publishing encode input", () => {
    // Given an encoder accepting complete context and a partial fragment.
    const name = "ConfigTranslateEncodeInput";
    // When both trees share an artifact.
    const schema = getJsonSchema(name);
    // Then the complete context and the partial fragment stay separate wire members.
    const definition = (schema as { definitions?: Record<string, unknown> }).definitions?.[name] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(
      definition?.properties ?? (schema as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("context");
    expect(
      definition?.properties ?? (schema as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("fragment");
    expect(schema).not.toHaveProperty("definitions.ServiceConfigInput");
  });

  test("passes annotation validation when publishing the public registry", () => {
    // Given the default public registry and inherited field exemptions.
    // When all registered annotations are validated.
    const issues = validatePublicSchemaAnnotations();
    // Then publication has no annotation debt beyond existing exemptions.
    expect(issues).toEqual([]);
  });

  test("includes translation results when listing public schema names", () => {
    // Given the public registry.
    // When its artifact names are enumerated.
    const names = JSON_SCHEMA_NAMES;
    // Then translation results have a published artifact.
    expect(names).toContain("ConfigTranslateResult");
  });
});
