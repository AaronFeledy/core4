import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SchemaAST as AST, Result, Schema } from "effect";

import { DeprecationUsedEvent, LandoEvent } from "@lando/sdk/events";
import {
  DeprecationNotice,
  DeprecationSurfaceKind,
  DeprecationUse,
  assertJsonSchemaDeprecationsValid,
  deprecateField,
  deprecateSchema,
  getJsonSchema,
  getJsonSchemaWithDeprecations,
  renderSchemaReferenceMarkdown,
  structuralDeprecationKey,
} from "@lando/sdk/schema";

const decode = (input: unknown) => Schema.decodeUnknownResult(DeprecationNotice)(input);

const rootJsonSchema = (schema: unknown): unknown => {
  if (schema === null || typeof schema !== "object") throw new TypeError("Expected a schema document");
  const ref: unknown = Reflect.get(schema, "$ref");
  if (typeof ref !== "string") return schema;
  const definitions: unknown = Reflect.get(schema, "definitions");
  if (definitions === null || typeof definitions !== "object") throw new TypeError("Expected definitions");
  return Reflect.get(definitions, ref.replace(/^#\/definitions\//, ""));
};

describe("DeprecationNotice", () => {
  test("decodes a notice and applies the default severity", () => {
    const decoded = decode({
      since: "4.2.0",
      removeIn: "5.0.0",
      replacement: "new.surface",
      note: "Use the new surface.",
      docsUrl: "https://docs.lando.dev/deprecations/new-surface",
      ticket: "https://github.com/lando/core/issues/1234",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.severity).toBe("warn");
    expect(structuralDeprecationKey(decoded.success)).toEqual({
      since: "4.2.0",
      removeIn: "5.0.0",
      note: "Use the new surface.",
    });
  });

  test("rejects invalid severity, semver, and docsUrl values", () => {
    expect(decode({ since: "4.2.0", severity: "fatal", note: "Use something else." })._tag).toBe("Failure");
    expect(decode({ since: "next", note: "Use something else." })._tag).toBe("Failure");
    expect(decode({ since: "4.2.0", note: "Use something else.", docsUrl: "not a url" })._tag).toBe(
      "Failure",
    );
  });

  test("rejects patch, same-release, and past removeIn releases", () => {
    expect(decode({ since: "4.2.0", removeIn: "4.2.1", note: "Use something else." })._tag).toBe("Failure");
    expect(decode({ since: "4.2.0", removeIn: "4.2.0", note: "Use something else." })._tag).toBe("Failure");
    expect(decode({ since: "4.2.0", removeIn: "4.1.0", note: "Use something else." })._tag).toBe("Failure");
  });

  test("requires removeIn for notices older than the active 4.x line", () => {
    expect(decode({ since: "3.21.0", note: "Use something else." })._tag).toBe("Failure");
    expect(decode({ since: "4.0.0", note: "Use something else." })._tag).toBe("Failure");
    expect(decode({ since: "4.2.0", note: "Use something else." })._tag).toBe("Success");
  });

  test("publishes JSON Schema through the registry", () => {
    expect(AST.resolveTitle(DeprecationNotice.ast)).toBe("Deprecation Notice");
    expect(JSON.stringify(getJsonSchemaWithDeprecations(DeprecationNotice))).toContain("Deprecation Notice");
    expect(
      JSON.stringify(
        (getJsonSchemaWithDeprecations(DeprecationNotice) as { definitions?: Record<string, unknown> })
          .definitions,
      ),
    ).not.toContain('"$ref"');
    const jsonSchema = getJsonSchema("DeprecationNotice") as Record<string, unknown>;
    expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(jsonSchema)).toContain("Deprecation Notice");
  });
});

describe("DeprecationUse", () => {
  test("decodes a runtime deprecation use with timestamp metadata", () => {
    const decoded = Schema.decodeUnknownResult(DeprecationUse)({
      kind: "command",
      id: "app:start",
      notice: {
        since: "4.1.0",
        severity: "warn",
        note: "Use app:up instead.",
      },
      callsite: "start",
      app: "myapp",
      plugin: "@lando/core",
      timestamp: "2026-06-11T16:00:00.000Z",
    });

    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success.kind).toBe("command");
      expect(decoded.success.id).toBe("app:start");
    }
  });

  test("rejects unknown deprecation surface kinds", () => {
    const decoded = Schema.decodeUnknownResult(DeprecationSurfaceKind)("not-a-surface");

    expect(decoded._tag).toBe("Failure");
  });
});

describe("DeprecationUsedEvent", () => {
  test("decodes a deprecation-used event payload and participates in the event union", () => {
    const payload = {
      _tag: "deprecation-used",
      use: {
        kind: "command",
        id: "app:start",
        notice: {
          since: "4.1.0",
          severity: "warn",
          note: "Use app:up instead.",
        },
        timestamp: "2026-06-11T16:00:00.000Z",
      },
    };

    const decoded = Schema.decodeUnknownResult(DeprecationUsedEvent)(payload);
    const event = Schema.decodeUnknownResult(LandoEvent)(payload);

    expect(decoded._tag).toBe("Success");
    expect(event._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success._tag).toBe("deprecation-used");
      expect(decoded.success.use.id).toBe("app:start");
    }
  });
});

describe("schema deprecation annotations", () => {
  const notice = {
    since: "4.2.0",
    removeIn: "5.0.0",
    severity: "warn" as const,
    replacement: "newField",
    note: "Use newField instead.",
    docsUrl: "https://docs.lando.dev/deprecations/old-field",
  };

  const ExampleSchema = deprecateSchema(
    Schema.Struct({
      oldField: deprecateField(Schema.String, notice),
      newField: Schema.String,
    }).annotate({
      identifier: "ExampleDeprecatedSchema",
      title: "Example Deprecated Schema",
      description: "A schema used to prove schema-level deprecation propagation.",
    }),
    notice,
  );

  test("emits deprecated JSON Schema metadata for annotated schemas and fields", () => {
    const jsonSchema = rootJsonSchema(getJsonSchemaWithDeprecations(ExampleSchema)) as {
      readonly deprecated?: boolean;
      readonly "x-deprecation"?: unknown;
      readonly properties?: Record<
        string,
        { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
      >;
    };

    expect(jsonSchema.deprecated).toBe(true);
    expect(jsonSchema["x-deprecation"]).toEqual(notice);
    expect(jsonSchema.properties?.oldField?.deprecated).toBe(true);
    expect(jsonSchema.properties?.oldField?.["x-deprecation"]).toEqual(notice);
    expect(jsonSchema.properties?.newField?.deprecated).toBeUndefined();
  });

  test("validates emitted x-deprecation payloads against DeprecationNotice", () => {
    const valid = getJsonSchemaWithDeprecations(ExampleSchema);
    expect(assertJsonSchemaDeprecationsValid(valid)).toEqual([]);

    const invalid = {
      type: "object",
      deprecated: true,
      "x-deprecation": { since: "next", note: "Use another surface." },
    };

    expect(assertJsonSchemaDeprecationsValid(invalid)).toEqual(["$"]);
    expect(
      assertJsonSchemaDeprecationsValid({
        type: "object",
        deprecated: true,
        "x-deprecation": { since: "4.2.0", removeIn: "5.0.0", note: "Use another surface.", extra: true },
      }),
    ).toEqual(["$"]);
  });

  test("propagates nested optional field deprecations", () => {
    const jsonSchema = getJsonSchemaWithDeprecations(
      Schema.Struct({ optionalOldField: Schema.optionalKey(deprecateField(Schema.String, notice)) }),
    ) as {
      readonly properties?: Record<
        string,
        { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
      >;
    };

    expect(jsonSchema.properties?.optionalOldField?.deprecated).toBe(true);
    expect(jsonSchema.properties?.optionalOldField?.["x-deprecation"]).toEqual(notice);
  });

  test("propagates array element deprecations to JSON Schema items and reference docs", () => {
    const ArraySchema = Schema.Struct({ oldValues: Schema.Array(deprecateField(Schema.String, notice)) });
    const jsonSchema = getJsonSchemaWithDeprecations(ArraySchema) as {
      readonly properties?: Record<
        string,
        {
          readonly deprecated?: boolean;
          readonly items?: { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown };
        }
      >;
    };
    const markdown = renderSchemaReferenceMarkdown("ArrayDeprecatedSchema", ArraySchema);

    expect(jsonSchema.properties?.oldValues?.deprecated).toBeUndefined();
    expect(jsonSchema.properties?.oldValues?.items?.deprecated).toBe(true);
    expect(jsonSchema.properties?.oldValues?.items?.["x-deprecation"]).toEqual(notice);
    expect(markdown).toContain(
      "| `oldValues` | Yes | `array` | — | — | — | — | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("propagates optionalWith transformation field deprecations to JSON Schema and reference docs", () => {
    const OptionalWithSchema = Schema.Struct({
      oldField: deprecateField(Schema.String, notice).pipe(
        Schema.withDecodingDefaultKey(Effect.sync(() => "legacy")),
      ),
      newField: Schema.String,
    });
    const jsonSchema = getJsonSchemaWithDeprecations(OptionalWithSchema) as {
      readonly properties?: Record<
        string,
        { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
      >;
    };
    const markdown = renderSchemaReferenceMarkdown("OptionalWithDeprecatedSchema", OptionalWithSchema);

    expect(jsonSchema.properties?.oldField?.deprecated).toBe(true);
    expect(jsonSchema.properties?.oldField?.["x-deprecation"]).toEqual(notice);
    expect(jsonSchema.properties?.newField?.deprecated).toBeUndefined();
    expect(markdown).toContain(
      "| `oldField` | No | `string` | — | — | — | — | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("propagates union branch field deprecations to matching JSON Schema anyOf members", () => {
    const UnionSchema = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("old"), oldField: deprecateField(Schema.String, notice) }),
      Schema.Struct({ kind: Schema.Literal("new"), newField: Schema.String }),
    ]);
    const jsonSchema = getJsonSchemaWithDeprecations(UnionSchema) as {
      readonly anyOf?: ReadonlyArray<{
        readonly properties?: Record<
          string,
          { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
        >;
      }>;
    };

    expect(jsonSchema.anyOf?.[0]?.properties?.oldField?.deprecated).toBe(true);
    expect(jsonSchema.anyOf?.[0]?.properties?.oldField?.["x-deprecation"]).toEqual(notice);
    expect(jsonSchema.anyOf?.[1]?.properties?.newField?.deprecated).toBeUndefined();
  });

  test("propagates deprecations through top-level and property refs into $defs", () => {
    const ReferencedChild = Schema.Struct({
      oldField: deprecateField(Schema.String, notice),
      newField: Schema.String,
    }).annotate({ identifier: "ReferencedDeprecatedChild" });
    const ReferencedParent = Schema.Struct({ child: ReferencedChild }).annotate({
      identifier: "ReferencedDeprecatedParent",
    });
    const jsonSchema = getJsonSchemaWithDeprecations(ReferencedParent) as {
      readonly $ref?: string;
      readonly definitions?: Record<
        string,
        {
          readonly properties?: Record<
            string,
            { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
          >;
        }
      >;
    };

    expect(jsonSchema.$ref).toBe("#/definitions/ReferencedDeprecatedParent");
    expect(jsonSchema.definitions?.ReferencedDeprecatedChild?.properties?.oldField?.deprecated).toBe(true);
    expect(
      jsonSchema.definitions?.ReferencedDeprecatedChild?.properties?.oldField?.["x-deprecation"],
    ).toEqual(notice);
    expect(
      jsonSchema.definitions?.ReferencedDeprecatedChild?.properties?.newField?.deprecated,
    ).toBeUndefined();
  });

  test("does not mark a union root deprecated when only one branch is deprecated", () => {
    const DeprecatedBranch = deprecateSchema(
      Schema.Struct({ kind: Schema.Literal("old"), value: Schema.String }),
      notice,
    );
    const CurrentBranch = Schema.Struct({ kind: Schema.Literal("new"), value: Schema.String });
    const jsonSchema = getJsonSchemaWithDeprecations(Schema.Union([DeprecatedBranch, CurrentBranch])) as {
      readonly deprecated?: boolean;
      readonly "x-deprecation"?: unknown;
      readonly anyOf?: ReadonlyArray<{ readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }>;
    };

    expect(jsonSchema.deprecated).toBeUndefined();
    expect(jsonSchema["x-deprecation"]).toBeUndefined();
    expect(jsonSchema.anyOf?.[0]?.deprecated).toBe(true);
    expect(jsonSchema.anyOf?.[0]?.["x-deprecation"]).toEqual(notice);
    expect(jsonSchema.anyOf?.[1]?.deprecated).toBeUndefined();
  });

  test("keeps whole-union deprecations on the union root", () => {
    const UnionSchema = deprecateSchema(Schema.Union([Schema.String, Schema.Number]), notice);
    const jsonSchema = getJsonSchemaWithDeprecations(UnionSchema) as {
      readonly deprecated?: boolean;
      readonly "x-deprecation"?: unknown;
      readonly anyOf?: ReadonlyArray<{ readonly deprecated?: boolean }>;
    };

    expect(jsonSchema.deprecated).toBe(true);
    expect(jsonSchema["x-deprecation"]).toEqual(notice);
    expect(jsonSchema.anyOf?.[0]?.deprecated).toBeUndefined();
    expect(jsonSchema.anyOf?.[1]?.deprecated).toBeUndefined();
  });

  test("propagates deprecations in output nullish unions where Effect encodes Undefined as null", () => {
    const NullishUnionSchema = Schema.Struct({
      nullishField: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("old"), oldField: deprecateField(Schema.String, notice) }),
        Schema.Struct({ kind: Schema.Literal("new"), newField: Schema.String }),
        Schema.Undefined,
      ]),
    });
    const jsonSchema = getJsonSchemaWithDeprecations(NullishUnionSchema) as {
      readonly properties?: Record<
        string,
        {
          readonly anyOf?: ReadonlyArray<{
            readonly properties?: Record<
              string,
              { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
            >;
          }>;
        }
      >;
    };

    expect(jsonSchema.properties?.nullishField?.anyOf).toHaveLength(3);
    expect(jsonSchema.properties?.nullishField?.anyOf?.[0]?.properties?.oldField?.deprecated).toBe(true);
    expect(jsonSchema.properties?.nullishField?.anyOf?.[0]?.properties?.oldField?.["x-deprecation"]).toEqual(
      notice,
    );
    expect(jsonSchema.properties?.nullishField?.anyOf?.[1]?.properties?.newField?.deprecated).toBeUndefined();
  });

  test("propagates record value deprecations to emitted index-signature schemas", () => {
    const StringRecord = Schema.Record(Schema.String, deprecateField(Schema.String, notice));
    const PatternRecord = Schema.Record(
      Schema.TemplateLiteral(["x-", Schema.String]),
      deprecateField(Schema.String, notice),
    );
    const stringJsonSchema = getJsonSchemaWithDeprecations(StringRecord) as {
      readonly additionalProperties?: { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown };
    };
    const patternJsonSchema = getJsonSchemaWithDeprecations(PatternRecord) as {
      readonly patternProperties?: Record<
        string,
        { readonly deprecated?: boolean; readonly "x-deprecation"?: unknown }
      >;
    };
    const patternSchema = Object.values(patternJsonSchema.patternProperties ?? {})[0];

    expect(stringJsonSchema.additionalProperties?.deprecated).toBe(true);
    expect(stringJsonSchema.additionalProperties?.["x-deprecation"]).toEqual(notice);
    expect(patternSchema?.deprecated).toBe(true);
    expect(patternSchema?.["x-deprecation"]).toEqual(notice);
  });

  test("renders generated reference field table when no fields are deprecated", () => {
    const markdown = renderSchemaReferenceMarkdown(
      "NoDeprecatedFieldsSchema",
      Schema.Struct({ newField: Schema.String }),
    );

    expect(markdown).toContain("# NoDeprecatedFieldsSchema");
    expect(markdown).toContain(
      "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
    );
    expect(markdown).toContain("| `newField` | Yes | `string` | a string | — | — | — | — |");
  });

  test("renders generated reference callouts from schema deprecation metadata", () => {
    const markdown = renderSchemaReferenceMarkdown("ExampleDeprecatedSchema", ExampleSchema);

    expect(markdown).toContain(
      "> [!WARNING]\n> Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead.",
    );
    expect(markdown).toContain(
      "| `oldField` | Yes | `string` | a string | — | — | — | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("renders generated reference callouts for nested optional field deprecations", () => {
    const markdown = renderSchemaReferenceMarkdown(
      "ExampleOptionalDeprecatedSchema",
      Schema.Struct({ optionalOldField: Schema.optionalKey(deprecateField(Schema.String, notice)) }),
    );

    expect(markdown).toContain(
      "| `optionalOldField` | No | `string` | — | — | — | — | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("adds hover documentation where schema annotations support it", () => {
    const docs = AST.resolve(ExampleSchema.ast)?.documentation;

    expect(docs).toBe("Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead.");
  });
});
