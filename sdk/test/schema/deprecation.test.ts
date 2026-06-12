import { Either, JSONSchema, Schema } from "effect";

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

const decode = (input: unknown) => Schema.decodeUnknownEither(DeprecationNotice)(input);

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

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;
    expect(decoded.right.severity).toBe("warn");
    expect(structuralDeprecationKey(decoded.right)).toEqual({
      since: "4.2.0",
      removeIn: "5.0.0",
      note: "Use the new surface.",
    });
  });

  test("rejects invalid severity, semver, and docsUrl values", () => {
    expect(decode({ since: "4.2.0", severity: "fatal", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "next", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", note: "Use something else.", docsUrl: "not a url" })._tag).toBe("Left");
  });

  test("rejects patch, same-release, and past removeIn releases", () => {
    expect(decode({ since: "4.2.0", removeIn: "4.2.1", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", removeIn: "4.2.0", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", removeIn: "4.1.0", note: "Use something else." })._tag).toBe("Left");
  });

  test("requires removeIn for notices older than the active 4.x line", () => {
    expect(decode({ since: "3.21.0", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.0.0", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", note: "Use something else." })._tag).toBe("Right");
  });

  test("publishes JSON Schema through the registry", () => {
    expect(
      Object.getOwnPropertySymbols(DeprecationNotice.ast.annotations).map(
        (key) => DeprecationNotice.ast.annotations[key],
      ),
    ).toContain("Deprecation Notice");
    expect(JSON.stringify(JSONSchema.make(DeprecationNotice))).toContain("Deprecation Notice");
    expect(
      JSON.stringify((JSONSchema.make(DeprecationNotice) as { $defs?: Record<string, unknown> }).$defs),
    ).not.toContain('"$ref"');
    const jsonSchema = getJsonSchema("DeprecationNotice") as Record<string, unknown>;
    expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(jsonSchema)).toContain("Deprecation Notice");
  });
});

describe("DeprecationUse", () => {
  test("decodes a runtime deprecation use with timestamp metadata", () => {
    const decoded = Schema.decodeUnknownEither(DeprecationUse)({
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

    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.kind).toBe("command");
      expect(decoded.right.id).toBe("app:start");
    }
  });

  test("rejects unknown deprecation surface kinds", () => {
    const decoded = Schema.decodeUnknownEither(DeprecationSurfaceKind)("not-a-surface");

    expect(decoded._tag).toBe("Left");
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

    const decoded = Schema.decodeUnknownEither(DeprecationUsedEvent)(payload);
    const event = Schema.decodeUnknownEither(LandoEvent)(payload);

    expect(decoded._tag).toBe("Right");
    expect(event._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right._tag).toBe("deprecation-used");
      expect(decoded.right.use.id).toBe("app:start");
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
    }).annotations({
      identifier: "ExampleDeprecatedSchema",
      title: "Example Deprecated Schema",
      description: "A schema used to prove schema-level deprecation propagation.",
    }),
    notice,
  );

  test("emits deprecated JSON Schema metadata for annotated schemas and fields", () => {
    const jsonSchema = getJsonSchemaWithDeprecations(ExampleSchema) as {
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
      Schema.Struct({ optionalOldField: Schema.optional(deprecateField(Schema.String, notice)) }),
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
      "| `oldValues` | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("propagates optionalWith transformation field deprecations to JSON Schema and reference docs", () => {
    const OptionalWithSchema = Schema.Struct({
      oldField: Schema.optionalWith(deprecateField(Schema.String, notice), { default: () => "legacy" }),
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
      "| `oldField` | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("propagates union branch field deprecations to matching JSON Schema anyOf members", () => {
    const UnionSchema = Schema.Union(
      Schema.Struct({ kind: Schema.Literal("old"), oldField: deprecateField(Schema.String, notice) }),
      Schema.Struct({ kind: Schema.Literal("new"), newField: Schema.String }),
    );
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

  test("omits generated reference field table when no fields are deprecated", () => {
    const markdown = renderSchemaReferenceMarkdown(
      "NoDeprecatedFieldsSchema",
      Schema.Struct({ newField: Schema.String }),
    );

    expect(markdown).toBe("# NoDeprecatedFieldsSchema\n");
    expect(markdown).not.toContain("| Field | Deprecation |");
  });

  test("renders generated reference callouts from schema deprecation metadata", () => {
    const markdown = renderSchemaReferenceMarkdown("ExampleDeprecatedSchema", ExampleSchema);

    expect(markdown).toContain(
      "> [!WARNING]\n> Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead.",
    );
    expect(markdown).toContain(
      "| `oldField` | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("renders generated reference callouts for nested optional field deprecations", () => {
    const markdown = renderSchemaReferenceMarkdown(
      "ExampleOptionalDeprecatedSchema",
      Schema.Struct({ optionalOldField: Schema.optional(deprecateField(Schema.String, notice)) }),
    );

    expect(markdown).toContain(
      "| `optionalOldField` | Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead. |",
    );
  });

  test("adds hover documentation where schema annotations support it", () => {
    const docs = Object.getOwnPropertySymbols(ExampleSchema.ast.annotations).map(
      (key) => ExampleSchema.ast.annotations[key],
    );

    expect(docs).toContain(
      "Deprecated since 4.2.0; remove in 5.0.0. Use newField instead. Use newField instead.",
    );
  });
});
