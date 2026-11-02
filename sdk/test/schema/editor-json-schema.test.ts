import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  LandofileAuthoringShape,
  getEditorJsonSchema,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect";
import { importableNode } from "./landofile-parity-json-schema-fixup.ts";

test.each(["LandofileShape", "GlobalConfig"] as const)("emits closed draft-07 %s editor schemas", (name) => {
  const artifact = getEditorJsonSchema(name);

  expect(artifact).toMatchObject({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    type: "object",
    additionalProperties: false,
  });
  expect(artifact).toHaveProperty("definitions");
  expect(artifact).not.toHaveProperty("$defs");
  expect(JSON.stringify(artifact)).not.toContain("#/$defs/");
});

test("preserves Landofile extension slots and descriptions in the editor projection", () => {
  const artifact = getEditorJsonSchema("LandofileShape");

  expect(artifact).toHaveProperty(["patternProperties", "^x-"]);
  expect(artifact).not.toHaveProperty("propertyNames");
  expect(artifact).toHaveProperty("properties.name.anyOf.0.description", expect.any(String));
  expect(artifact).toHaveProperty(
    "properties.services.anyOf.0.additionalProperties.anyOf.0.$ref",
    expect.stringMatching(/^#\/definitions\//),
  );
});

test("publishes native merge directive tags without widening Landofile fields", () => {
  // Given the Landofile editor projection.
  const artifact = getEditorJsonSchema("LandofileShape");

  // Then the informational tag registry names both directives and every YAML node kind.
  for (const tag of ["!override", "!reset"])
    expect(artifact).toHaveProperty(["x-lando-yaml-tags", tag, "kinds"], ["scalar", "sequence", "mapping"]);
  expect(getEditorJsonSchema("GlobalConfig")).not.toHaveProperty("x-lando-yaml-tags");
  // And no field schema admits the internal directive brand or wire envelope.
  const text = JSON.stringify({ ...artifact, "x-lando-yaml-tags": undefined });
  expect(text).not.toContain("LandofileReset");
  expect(text).not.toContain("LandofileOverride");
  expect(text).not.toContain("merge-directive");
});

const editorAuthoring = Schema.make<Schema.Codec<unknown>>(
  SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft07(getEditorJsonSchema("LandofileShape")),
    { patterns: "apply", onEnter: importableNode },
  ).ast,
);

test.each([
  [true, true],
  [false, true],
  ["TrUe", true],
  ["oFf", true],
  ["YeS", true],
  ["nO", true],
  ["1", true],
  ["0", true],
  ["{{ vars.init }}", true],
  ["{{ boolean(env.INIT) }}", true],
  ["prefix{{ vars.init }}suffix", true],
  ["{{- vars.init -}}", true],
  ["{{ vars.init }}{{ env.INIT }}", true],
  ["{{# comment #}}{{ vars.init }}", true],
  ["${INIT}", true],
  ["${INIT:-false}", true],
  ["${INIT-false}", true],
  ["$INIT", true],
  ["${secret:INIT}", true],
  ["${secret:init-flag}", true],
  ["$${LITERAL}{{ vars.init }}", true],
  ["sometimes", false],
  [" true", false],
  ["false ", false],
  ["true\n", false],
  ["$${INIT}", false],
  ["{{{{ vars.init }}", false],
  ["{{# comment #}}", false],
  ["", false],
  [1, false],
  [null, false],
] as const)("editor init acceptance matches authoring for %j", (init, accepted) => {
  // Given
  const input = { name: "demo", services: { web: { init } } };
  const options = { onExcessProperty: "error", errors: "all" } as const;
  // When
  const editor = Schema.decodeUnknownResult(editorAuthoring)(input, options);
  const authoring = Schema.decodeUnknownResult(LandofileAuthoringShape)(input, options);
  // Then
  expect(Result.isSuccess(authoring)).toBe(accepted);
  expect(Result.isSuccess(editor)).toBe(accepted);
  if (Result.isFailure(authoring)) {
    expect(
      validationIssuesFromSchemaIssue(authoring.failure.issue).map((issue) => issue.path),
    ).toContainEqual(["services", "web", "init"]);
  }
});

test("bounds repeated-comment validation and still accepts a following expression", async () => {
  // Given comment-only input and the same prefix followed by a legitimate expression.
  const script = `
    import { getEditorJsonSchema } from "@lando/sdk/schema";
    import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect";
    import { importableNode } from ${JSON.stringify(new URL("./landofile-parity-json-schema-fixup.ts", import.meta.url).href)};
    const editor = Schema.make(SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft07(getEditorJsonSchema("LandofileShape")),
      { patterns: "apply", onEnter: importableNode },
    ).ast);
    const prefix = "{{# x #}}".repeat(1000);
    for (let index = 0; index < 8; index++) {
      for (const [suffix, accepted] of [["", false], ["{{ vars.init }}", true]]) {
        const result = Schema.decodeUnknownResult(editor)({ name: "demo", services: { web: { init: prefix + suffix } } });
        if (Result.isSuccess(result) !== accepted) process.exit(1);
      }
    }
    process.stdout.write("16");
  `;
  // When the real editor decoder runs in a child with a generous hard deadline.
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // Then both outcomes complete without runaway backtracking or lost acceptance.
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "16", stderr: "" });
}, 10_000);
