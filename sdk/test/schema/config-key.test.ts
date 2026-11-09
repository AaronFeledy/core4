import { describe, expect, test } from "bun:test";
import { ConfigKeyDescription, describeJsonSchemaPath, getJsonSchema } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const describePath = (
  document: Parameters<typeof describeJsonSchemaPath>[0],
  path: readonly (string | number)[],
) => Result.getOrThrow(describeJsonSchemaPath(document, path));

describe("config key schema navigation", () => {
  test("does not treat inherited object properties as config keys", () => {
    expect(
      Result.isFailure(
        describeJsonSchemaPath({ properties: { port: { type: "integer" } }, additionalProperties: false }, [
          "__proto__",
        ]),
      ),
    ).toBe(true);
  });
  test("collects constraints from references, siblings, and every matching pattern", () => {
    const document = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/a~1b~0c",
      properties: { port: { maximum: 65535 } },
      allOf: [{ patternProperties: { "^port$": { minimum: 1 }, ort$: { description: "Listener port." } } }],
      $defs: { "a/b~c": { properties: { port: { type: "integer" } } } },
    };
    const result = describePath(document, ["port"]);
    expect(result).toMatchObject({ summary: "an integer from 1 to 65535", description: "Listener port." });
    expect(result.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 65535 });
  });

  test("uses additionalProperties only when neither a property nor a pattern matches", () => {
    const document = {
      properties: { fixed: { type: "string" } },
      patternProperties: { "^x-": { type: "boolean" } },
      additionalProperties: { type: "integer" },
    };
    expect(["fixed", "x-foo", "other"].map((key) => describePath(document, [key]).summary)).toEqual([
      "text",
      "`true` or `false`",
      "an integer",
    ]);
  });

  test.each([true, {}])("resolves descendants of unconstrained schema %j", (node) => {
    expect(describePath({ properties: { extension: node } }, ["extension", "nested", 0]).summary).toBe(
      "any value",
    );
  });

  test.each([false, { not: {}, description: "Rejected. Use ports instead." }])(
    "describes forbidden fields %j",
    (node) => {
      const result = describePath({ properties: { legacy: node } }, ["legacy"]);
      expect(result.summary).toBe("not accepted");
      if (node !== false) expect(result.description).toBe("Rejected. Use ports instead.");
    },
  );

  test("navigates tuple and list positions", () => {
    const document = { type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } };
    expect([0, 1].map((index) => describePath(document, [index]).summary)).toEqual(["text", "an integer"]);
  });

  test.each(["anyOf", "oneOf"])("keeps accepted children in %s despite anti-fields", (keyword) => {
    const document = {
      [keyword]: [{ properties: { port: { not: {} } } }, { properties: { port: { type: "integer" } } }],
    };
    expect(describePath(document, ["port"]).summary).toBe("an integer");
  });

  test("reports parent keys and the existing closest-key suggestion", () => {
    const result = describeJsonSchemaPath(
      {
        properties: {
          router: { properties: { httpPort: { type: "integer" } }, additionalProperties: false },
        },
      },
      ["router", "httpPor"],
    );
    expect(Result.isFailure(result) ? result.failure : undefined).toEqual({
      parent: ["router"],
      validKeys: ["httpPort"],
      suggestion: 'Did you mean "httpPort"?',
    });
  });

  test("projects transitive definitions without mutating the source", () => {
    const document = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { list: { type: "array", items: { $ref: "#/$defs/first" } } },
      $defs: { first: { $ref: "#/$defs/second" }, second: { type: "string" }, unused: { type: "boolean" } },
    };
    const before = structuredClone(document);
    expect(describePath(document, ["list"]).schema).toEqual({
      $schema: document.$schema,
      type: "array",
      items: { $ref: "#/$defs/first" },
      $defs: { first: document.$defs.first, second: document.$defs.second },
    });
    expect(document).toEqual(before);
  });

  test("terminates reference cycles", () => {
    const document = {
      $ref: "#/$defs/node",
      $defs: { node: { $ref: "#/$defs/node", properties: { name: { type: "string" } } } },
    };
    expect(describePath(document, ["name"]).summary).toBe("text");
  });

  test("terminates recursive list and union descriptions while preserving their references", () => {
    const document = {
      $defs: { node: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/node" } }] } },
      $ref: "#/$defs/node",
    };
    expect(describePath(document, []).summary).toBe("text or a list of any values");
    expect(describePath(document, [0]).schema).toMatchObject({ $defs: { node: document.$defs.node } });
  });

  test("rebases local pointers outside definitions into a self-contained field fragment", () => {
    const document = {
      properties: {
        name: { type: "string" },
        names: { type: "array", items: { $ref: "#/properties/name" } },
      },
    };
    const result = describePath(document, ["names"]);
    expect(result.schema).toEqual({
      type: "array",
      items: { $ref: "#/$defs/__projected_0" },
      $defs: { __projected_0: { type: "string" } },
    });
  });

  test("intersects numeric kinds and enum constraints across conjuncts", () => {
    expect(
      describePath(
        {
          allOf: [
            { type: "integer", minimum: 1 },
            { type: "number", maximum: 5 },
          ],
        },
        [],
      ).summary,
    ).toBe("an integer from 1 to 5");
    expect(
      describePath({ allOf: [{ enum: ["error", "warn"] }, { enum: ["warn", "info"] }] }, []).summary,
    ).toBe("`warn`");
  });

  test.each([{ default: false }, { allOf: [{ default: false }] }])(
    "reads defaults from annotations %j",
    (annotation) => {
      const result = describePath({ properties: { enabled: { type: "boolean", ...annotation } } }, [
        "enabled",
      ]);
      expect(result.default).toBe(false);
      expect(Schema.decodeUnknownSync(ConfigKeyDescription)(result)).toEqual(result);
    },
  );

  test.each([
    [{ type: "number", exclusiveMinimum: 0 }, "a number greater than 0"],
    [{ type: "integer", minimum: 1 }, "an integer of at least 1"],
    [{ type: "string", maxLength: 63 }, "text of at most 63 characters"],
    [{ type: "string", minLength: 1 }, "text of at least 1 character"],
    [{ type: "array", items: { type: "string" }, maxItems: 1 }, "a list of text values with at most 1 item"],
    [
      { type: "object", additionalProperties: { type: "string" }, maxProperties: 1 },
      "a mapping of names to text with at most 1 entry",
    ],
    [{ enum: ["none", "error", "warn"] }, "one of `none`, `error`, `warn`"],
    [{ anyOf: [{ const: "windows" }, { type: "string", format: "ip" }] }, "`windows` or text in ip format"],
    [{ type: ["string", "boolean", "null"] }, "text, a boolean, or `null`"],
    [
      { type: "array", items: { type: "integer", minimum: 1, maximum: 65535 } },
      "a list of integers from 1 to 65535",
    ],
  ] as const)("summarizes %j", (document, expected) => {
    expect(describePath(document, []).summary).toBe(expected);
  });

  test.each([
    ["GlobalConfig", ["router", "httpPort"], "an integer from 1 to 65535"],
    ["GlobalConfig", ["appEnv"], "a mapping of names to text with at most 256 entries"],
    ["GlobalConfig", ["hostProxy", "allowedSchemes"], "a list of text values"],
    ["LandofileShape", ["services", "web", "type"], "text"],
    ["LandofileShape", ["services", "web", "cap_add"], "text or a list of text values"],
    ["LandofileShape", ["services", "web", "ports"], "a list of text values, numbers, or mappings"],
    ["LandofileShape", ["x-foo", "nested"], "any value"],
  ] as const)("describes published %s at %j", (name, path, expected) => {
    expect(describePath(getJsonSchema(name), path).summary).toBe(expected);
  });

  test("describes encoded port aliases and lists full child paths", () => {
    const document = getJsonSchema("LandofileShape");
    const result = describePath(document, ["services", "web", "ports", 0]);
    expect(result.keys?.find((child) => child.key === "services.web.ports[0].host_ip")?.summary).toBe(
      "text in ip format",
    );
    expect(describePath(document, ["services", "web", "ports"]).schema).toMatchObject({
      type: "array",
      items: { anyOf: expect.any(Array) },
    });
  });
});
