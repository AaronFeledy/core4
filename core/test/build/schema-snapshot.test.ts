import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { JsonSchemaName } from "../../../sdk/src/schema/index.ts";

import {
  JSON_SCHEMA_NAMES,
  assertPublicSchemaAnnotations,
  deprecateField,
  deprecateSchema,
  publicSchemaMetadataIndex,
  publicSchemaRegistry,
  renderPublicSchemaReferencePages,
  renderSchemaReferenceMarkdown,
  schemaArtifactFilename,
  validatePublicSchemaAnnotations,
} from "../../../sdk/src/schema/index.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const snapshotPath = resolve(repoRoot, "sdk/test/fixtures/schema-snapshot.json");
const generatorPath = resolve(repoRoot, "scripts/build-schema-snapshot.ts");
const deprecationNoticeArtifactPath = resolve(repoRoot, "dist/schemas/deprecation-notice.json");
const metadataIndexPath = resolve(repoRoot, "dist/schemas/index.json");
const deprecationNoticeReferencePath = resolve(repoRoot, "docs/reference/schemas/deprecation-notice.mdx");

const schemaArtifactPath = (schemaName: JsonSchemaName): string =>
  resolve(repoRoot, "dist/schemas", schemaArtifactFilename(schemaName));

const runGenerator = (): void => {
  const proc = Bun.spawnSync([process.execPath, generatorPath], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect({
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
};

describe("schema snapshot gate", () => {
  test("generator is idempotent", async () => {
    const before = await readFile(snapshotPath, "utf8");

    runGenerator();

    expect(await readFile(snapshotPath, "utf8")).toBe(before);
  });

  test("snapshot scope is SDK schemas plus bundled plugin manifests", async () => {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      readonly scope: {
        readonly sdkSchemas: ReadonlyArray<string>;
        readonly bundledPluginManifests: ReadonlyArray<string>;
      };
      readonly sdkSchemas: Record<string, unknown>;
      readonly bundledPluginManifests: ReadonlyArray<{ readonly name: string }>;
    };

    expect(Object.keys(snapshot.sdkSchemas).sort()).toEqual([...snapshot.scope.sdkSchemas].sort());
    expect(snapshot.scope.sdkSchemas).toContain("PluginManifest");
    expect(snapshot.scope.sdkSchemas).toContain("DeprecationNotice");
    expect(snapshot.scope.sdkSchemas).toContain("AppPlan");
    expect(snapshot.scope.sdkSchemas).toEqual(JSON_SCHEMA_NAMES);
    expect(snapshot.scope.sdkSchemas).toContain("ServiceConfig");
    expect(snapshot.scope.sdkSchemas).toContain("ExpressionTemplate");
    expect(snapshot.scope.sdkSchemas).toContain("LandofileExpressionParseError");
    expect(snapshot.scope.sdkSchemas).toContain("LandoEvent");

    const bundledNames = BUNDLED_PLUGINS.map((plugin) => plugin.name).sort();
    expect(snapshot.scope.bundledPluginManifests).toEqual(bundledNames);
    expect(snapshot.bundledPluginManifests.map((plugin) => plugin.name).sort()).toEqual(bundledNames);
  });

  test("snapshot freezes a result schema for every canonical command id", async () => {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      readonly scope: { readonly commandResultSchemas: ReadonlyArray<string> };
      readonly commandResultSchemas: Record<string, { readonly $schema?: string }>;
    };

    const canonicalIds = Object.keys(compiledCommands).sort();

    expect(Object.keys(snapshot.commandResultSchemas).sort()).toEqual(canonicalIds);
    expect([...snapshot.scope.commandResultSchemas].sort()).toEqual(canonicalIds);
    for (const id of canonicalIds) {
      expect(snapshot.commandResultSchemas[id]).toBeDefined();
    }
  });

  test("public registry drives schema names and metadata index", async () => {
    runGenerator();

    const generated = JSON.parse(
      await readFile(metadataIndexPath, "utf8"),
    ) as typeof publicSchemaMetadataIndex;

    expect(Object.keys(publicSchemaRegistry)).toEqual(JSON_SCHEMA_NAMES);
    expect(generated).toEqual(publicSchemaMetadataIndex);
    expect(generated.map((entry) => entry.id)).toEqual(JSON_SCHEMA_NAMES);
    expect(generated.find((entry) => entry.id === "DeprecationNotice")).toMatchObject({
      title: "Deprecation Notice",
      packageExport: "@lando/sdk/schema#DeprecationNotice",
      jsonSchemaPath: "dist/schemas/deprecation-notice.json",
      docsPath: "docs/reference/schemas/deprecation-notice.mdx",
      deprecated: false,
    });
  });

  test("public registry drives generated reference page inputs", () => {
    const pages = renderPublicSchemaReferencePages();

    expect(pages.map((page) => page.id)).toEqual(JSON_SCHEMA_NAMES);
    expect(pages.map((page) => page.docsPath)).toEqual(
      publicSchemaMetadataIndex.map((entry) => entry.docsPath),
    );
    expect(pages.find((page) => page.id === "DeprecationNotice")).toMatchObject({
      docsPath: "docs/reference/schemas/deprecation-notice.mdx",
      content: expect.stringContaining("# Deprecation Notice"),
    });
  });

  test("generated reference pages include Starlight frontmatter, artifact links, and field details", () => {
    const pages = renderPublicSchemaReferencePages();
    const page = pages.find((entry) => entry.id === "DeprecationNotice");

    expect(page?.content).toContain("---\ntitle: Deprecation Notice");
    expect(page?.content).toContain(
      "description: A structured deprecation declaration attached to a public surface.",
    );
    expect(page?.content).toContain("[JSON Schema artifact](../../../dist/schemas/deprecation-notice.json)");
    expect(page?.content).toContain(
      "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
    );
    expect(page?.content).toContain("| `since` | Yes | `string` | a string matching the pattern");
    expect(page?.content).toContain(
      "| `severity` | No | `string` | — | — | `info`, `warn`, `error` | — | — |",
    );

    const primitivePage = pages.find((entry) => entry.id === "AppId");
    expect(primitivePage?.content).toContain("---\ntitle: App Id");
    expect(primitivePage?.content).toContain("Public Lando schema contract for App Id.");

    const enumPage = pages.find((entry) => entry.id === "BootstrapLevel");
    expect(enumPage?.content).toContain("| Type | Default | Accepted values | Examples |");
    expect(enumPage?.content).toContain(
      "`none`, `minimal`, `plugins`, `commands`, `tooling`, `provider`, `global`, `scratch`, `app`",
    );
  });

  test("reference renderer keeps empty structs in the field table shape", () => {
    const rendered = renderSchemaReferenceMarkdown("EmptyShape", Schema.Struct({}));

    expect(rendered).toContain(
      "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
    );
    expect(rendered).not.toContain("## Schema details");
  });

  test("reference renderer documents root record schemas", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "StringMap",
      Schema.Record({ key: Schema.String, value: Schema.String }),
    );

    expect(rendered).toContain(
      "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
    );
    expect(rendered).toContain("## Schema details");
    expect(rendered).toContain("| Keys | Values |");
    expect(rendered).toContain("| `string` | `string` |");
  });

  test("reference renderer uses provided JSON Schema field metadata", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "ArtifactBackedShape",
      Schema.Struct({
        value: Schema.String.annotations({ description: "Documented value." }),
      }),
      {
        jsonSchema: {
          type: "object",
          properties: {
            value: { type: "number", default: 7, enum: [7] },
          },
        },
      },
    );

    expect(rendered).toContain("| `value` | Yes | `number` | Documented value. | `7` | `7` | — | — |");
  });

  test("reference renderer resolves property refs against the full JSON Schema document", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "RefBackedShape",
      Schema.Struct({
        value: Schema.String.annotations({ description: "Documented value." }),
      }),
      {
        jsonSchema: {
          type: "object",
          properties: {
            value: { $ref: "#/$defs/NamedValue" },
          },
          $defs: {
            NamedValue: { type: "string", default: "alpha", enum: ["alpha", "beta"] },
          },
        },
      },
    );

    expect(rendered).toContain(
      "| `value` | Yes | `string` | Documented value. | `alpha` | `alpha`, `beta` | — | — |",
    );
    expect(rendered).not.toContain('`"alpha"`');
  });

  test("reference renderer formats examples without double-encoding strings", () => {
    const fieldRendered = renderSchemaReferenceMarkdown(
      "ExampleShape",
      Schema.Struct({
        value: Schema.String.annotations({
          description: "Documented value.",
          examples: ["alpha", { nested: true }],
        }),
      }),
      {
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    );
    const rootRendered = renderSchemaReferenceMarkdown(
      "RootExample",
      Schema.String.annotations({ examples: ["root", { nested: true }] }),
      { jsonSchema: { type: "string" } },
    );

    expect(fieldRendered).toContain(
      '| `value` | Yes | `string` | Documented value. | — | — | `alpha`, `{"nested":true}` | — |',
    );
    expect(rootRendered).toContain('| `string` | — | — | `root`, `{"nested":true}` |');
    expect(fieldRendered).not.toContain('`"alpha"`');
    expect(rootRendered).not.toContain('`"root"`');
  });

  test("reference renderer escapes MDX-significant body and field text", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "MdxUnsafeShape",
      Schema.Struct({
        value: Schema.String.annotations({ description: "Field <Value> uses {template} | pipes." }),
      }),
      {
        title: "Alpha <Guide> {shape} & docs",
        description: "Body <Guide> uses {children} & props.",
      },
    );
    const body = rendered.split("---").slice(2).join("---");

    expect(body).toContain("# Alpha &lt;Guide&gt; &#123;shape&#125; &amp; docs");
    expect(body).toContain("Body &lt;Guide&gt; uses &#123;children&#125; &amp; props.");
    expect(body).toContain(
      "| `value` | Yes | `string` | Field &lt;Value&gt; uses &#123;template&#125; \\| pipes. | — | — | — | — |",
    );
    expect(body).not.toContain("<Guide>");
    expect(body).not.toContain("{children}");
    expect(body).not.toContain("<Value>");
  });

  test("reference renderer derives field metadata from JSON Schema union branches", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "UnionBackedShape",
      Schema.Struct({
        value: Schema.Union(
          Schema.Literal(false),
          Schema.String,
          Schema.Struct({ id: Schema.String }),
        ).annotations({
          description: "Documented union value.",
        }),
      }),
      {
        jsonSchema: {
          type: "object",
          properties: {
            value: {
              anyOf: [
                { const: false },
                { enum: ["ready", "done"] },
                { type: "object", properties: { id: { type: "string" } } },
              ],
            },
          },
        },
      },
    );

    expect(rendered).toContain(
      "| `value` | Yes | `boolean`, `string`, `object` | Documented union value. | — | `false`, `ready`, `done` | — | — |",
    );
  });

  test("reference renderer surfaces root union branch types", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "CommandLike",
      Schema.Union(Schema.String, Schema.Array(Schema.String)),
      {
        jsonSchema: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
    );

    expect(rendered).toContain("## Schema details");
    expect(rendered).toContain("| `string`, `array` | — | — | — |");
  });

  test("reference renderer surfaces root union object branch fields as optional when branch-specific", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "RunLike",
      Schema.Union(
        Schema.Struct({
          command: Schema.String.annotations({ description: "Command to execute." }),
        }),
        Schema.Struct({
          shell: Schema.String.annotations({ description: "Shell command to execute." }),
        }),
      ),
      {
        jsonSchema: {
          anyOf: [
            {
              type: "object",
              required: ["command"],
              properties: { command: { type: "string" } },
            },
            {
              type: "object",
              required: ["shell"],
              properties: { shell: { type: "string" } },
            },
          ],
        },
      },
    );

    expect(rendered).not.toContain("## Schema details");
    expect(rendered).toContain(
      "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
    );
    expect(rendered).toContain("| `command` | No | `string` | Command to execute. | — | — | — | — |");
    expect(rendered).toContain("| `shell` | No | `string` | Shell command to execute. | — | — | — | — |");
  });

  test("reference renderer marks root union fields required only when present and required in every branch", () => {
    const rendered = renderSchemaReferenceMarkdown(
      "VariantLike",
      Schema.Union(
        Schema.Struct({
          shared: Schema.String.annotations({ description: "Shared field." }),
          requiredOnly: Schema.String.annotations({ description: "Required variant field." }),
        }),
        Schema.Struct({
          shared: Schema.optional(Schema.String).annotations({ description: "Shared field." }),
          optionalOnly: Schema.optional(Schema.String).annotations({
            description: "Optional variant field.",
          }),
        }),
      ),
      {
        jsonSchema: {
          anyOf: [
            {
              type: "object",
              required: ["shared", "requiredOnly"],
              properties: {
                shared: { type: "string" },
                requiredOnly: { type: "string" },
              },
            },
            {
              type: "object",
              required: [],
              properties: {
                shared: { type: "string" },
                optionalOnly: { type: "string" },
              },
            },
          ],
        },
      },
    );

    expect(rendered).toContain("| `shared` | No | `string` | Shared field. | — | — | — | — |");
    expect(rendered).toContain(
      "| `requiredOnly` | No | `string` | Required variant field. | — | — | — | — |",
    );
    expect(rendered).toContain(
      "| `optionalOnly` | No | `string` | Optional variant field. | — | — | — | — |",
    );
  });

  test("reference renderer surfaces deprecated schema and field callouts", () => {
    const notice = {
      since: "4.2.0",
      note: "Use the replacement schema instead.",
      replacement: "ReplacementSchema",
      severity: "warn" as const,
    };
    const DeprecatedShape = deprecateSchema(
      Schema.Struct({
        oldField: deprecateField(
          Schema.String.annotations({ description: "Deprecated field retained for compatibility." }),
          notice,
        ),
      }).annotations({
        identifier: "DeprecatedShape",
        title: "Deprecated Shape",
        description: "A schema used to prove deprecation reference rendering.",
      }),
      notice,
    );

    const rendered = renderSchemaReferenceMarkdown("DeprecatedShape", DeprecatedShape, {
      jsonSchemaPath: "dist/schemas/deprecated-shape.json",
    });

    expect(rendered).toContain("> [!WARNING]\n> Deprecated since 4.2.0");
    expect(rendered).toContain(
      "| `oldField` | Yes | `string` | Deprecated field retained for compatibility. | — | — | — | Deprecated since 4.2.0",
    );
  });

  test("generator writes generated schema reference docs", async () => {
    runGenerator();

    const generated = await Bun.file(deprecationNoticeReferencePath).text();
    const expected = renderPublicSchemaReferencePages().find(
      (entry) => entry.id === "DeprecationNotice",
    )?.content;
    expect(generated).toBe(expected);
  });

  test("public schema registry entries carry required annotations", () => {
    expect(validatePublicSchemaAnnotations()).toEqual([]);
  });

  test("schema annotation gate names missing top-level annotations", () => {
    const MissingTopLevelAnnotations = Schema.Struct({ id: Schema.String }).annotations({
      identifier: "MissingTopLevelAnnotations",
    });

    expect(() => assertPublicSchemaAnnotations({ MissingTopLevelAnnotations })).toThrow(
      /MissingTopLevelAnnotations: Missing required title annotation/,
    );
  });

  test("schema annotation gate names undescribed public fields", () => {
    const MissingFieldDescription = Schema.Struct({ id: Schema.String }).annotations({
      identifier: "MissingFieldDescription",
      title: "Missing Field Description",
      description: "A schema used to prove field annotation enforcement.",
    });

    expect(() => assertPublicSchemaAnnotations({ MissingFieldDescription })).toThrow(
      /MissingFieldDescription\.id: Missing field description annotation/,
    );
  });

  test("schema annotation gate validates attached examples", () => {
    const InvalidExample = Schema.Struct({
      mode: Schema.Literal("valid").annotations({ description: "Allowed mode literal." }),
    }).annotations({
      identifier: "InvalidExample",
      title: "Invalid Example",
      description: "A schema used to prove example validation.",
      examples: [{ mode: "invalid" }],
    });

    expect(() => assertPublicSchemaAnnotations({ InvalidExample })).toThrow(
      /InvalidExample\.examples\[0\]: Example does not decode successfully/,
    );
  });

  test("schema annotation gate validates attached field examples", () => {
    const InvalidFieldExample = Schema.Struct({
      mode: Schema.Literal("valid").annotations({
        description: "Allowed mode literal.",
        examples: ["invalid"],
      }),
    }).annotations({
      identifier: "InvalidFieldExample",
      title: "Invalid Field Example",
      description: "A schema used to prove field-level example validation.",
    });

    expect(() => assertPublicSchemaAnnotations({ InvalidFieldExample })).toThrow(
      /InvalidFieldExample\.mode\.examples\[0\]: Example does not decode successfully/,
    );
  });

  test("generator emits the deprecation notice schema artifact", async () => {
    runGenerator();

    const artifact = JSON.parse(await readFile(deprecationNoticeArtifactPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(artifact.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(artifact)).toContain("Deprecation Notice");
  });

  test("generator emits a draft-07 schema artifact for every public SDK schema", async () => {
    runGenerator();

    for (const schemaName of JSON_SCHEMA_NAMES) {
      const artifact = JSON.parse(await readFile(schemaArtifactPath(schemaName), "utf8")) as Record<
        string,
        unknown
      >;

      expect(artifact.$schema, schemaName).toBe("http://json-schema.org/draft-07/schema#");
    }
  });

  test("generated JSON schema artifacts are tracked by git for the drift gate", () => {
    const ignored = Bun.spawnSync(
      ["git", "check-ignore", "-q", "--no-index", "dist/schemas/new-schema.json"],
      {
        cwd: repoRoot,
      },
    );
    expect(ignored.exitCode).toBe(1);

    const tracked = Bun.spawnSync(["git", "ls-files", "dist/schemas"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: tracked.exitCode, stderr: tracked.stderr.toString() }).toMatchObject({
      exitCode: 0,
    });

    const trackedFiles = new Set(tracked.stdout.toString().trim().split("\n"));
    expect(trackedFiles).toContain("dist/schemas/index.json");
    for (const schemaName of JSON_SCHEMA_NAMES) {
      expect(trackedFiles).toContain(`dist/schemas/${schemaArtifactFilename(schemaName)}`);
    }
  });
});
