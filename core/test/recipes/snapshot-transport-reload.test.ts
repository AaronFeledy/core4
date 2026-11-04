import { expect, test } from "bun:test";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { emitCompiledLandofileYaml } from "@lando/landofile/serializer";
import { renderCompiledRecipeSnapshot, renderRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath, type RecipeSnapshot, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { encodedStringNode, lit, obj } from "../../src/recipes/builtin/snapshot-expression.ts";

test("reloads encoded authored references while equal helper and option values remain literal", async () => {
  // Given
  const text = "${secret:DB}";
  const fixture: RecipeSnapshot = {
    identity: {
      sourceKind: "bundled",
      packageName: "recipes",
      recipeId: "transport",
      manifestVersion: "1.0.0",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    defaults: {},
    optionTypes: {},
    assets: [],
    template: {
      expression: obj([
        ["runtime", lit(4)],
        ["name", lit("transport")],
        [
          "services",
          obj([
            [
              "web",
              obj([
                ["type", lit("nginx")],
                [
                  "environment",
                  obj([
                    ["AUTHORED", encodedStringNode(text)],
                    ["BASE64", { kind: "Call", callee: "b64decode", args: [lit(btoa(text))] }],
                    ["JSON", { kind: "Call", callee: "fromJson", args: [lit(JSON.stringify(text))] }],
                    ["OPTION", { kind: "Path", head: "options", segments: [{ type: "prop", name: "text" }] }],
                    ["STATIC", encodedStringNode('"{{ app.name }}"\n{{ services.database.creds.password }}')],
                  ]),
                ],
              ]),
            ],
          ]),
        ],
      ]),
    },
  };
  const root = "/tmp/snapshot-transport-reload";
  const file = `${root}/.lando.yml`;
  // When
  const compiled = Result.getOrThrow(
    renderCompiledRecipeSnapshot(
      fixture,
      { text },
      {
        appRoot: AbsolutePath.make(root),
        env: {},
      },
    ),
  );
  const content = emitCompiledLandofileYaml(compiled);
  const reloaded = await Effect.runPromise(
    parseLandofile({ file, cwd: root, content }).pipe(
      Effect.flatMap((value) => loadAuthoredDocuments([{ file, value }], { appRoot: root, file })),
    ),
  );
  // Then
  expect(reloaded.document.services?.[ServiceName.make("web")]?.environment).toEqual({
    AUTHORED: { _tag: "SecretRef", reference: "DB" },
    BASE64: text,
    JSON: text,
    OPTION: text,
    STATIC: '"{{ app.name }}"\n{{ services.database.creds.password }}',
  });
  expect(reloaded.pendingSites.map((site) => site.path)).toEqual([
    ["services", "web", "environment", "STATIC"],
  ]);
});

test("round trips Unicode and literal escapes through the authored transport", () => {
  // Given
  const text = 'café 🐈\n"quoted" $${secret:INERT}';
  const fixture: RecipeSnapshot = {
    identity: {
      sourceKind: "bundled",
      packageName: "recipes",
      recipeId: "unicode",
      manifestVersion: "1.0.0",
      contentDigest: `sha256:${"b".repeat(64)}`,
    },
    defaults: {},
    optionTypes: {},
    assets: [],
    template: { expression: encodedStringNode(text) },
  };
  // When
  const rendered = Result.getOrThrow(renderRecipeSnapshot(fixture, {}));
  const compiled = Result.getOrThrow(
    renderCompiledRecipeSnapshot(
      fixture,
      {},
      {
        appRoot: AbsolutePath.make("/tmp/transport-unicode"),
        env: {},
      },
    ),
  );
  // Then
  expect(rendered).toBe(text);
  expect(compiled.document).toBe('café 🐈\n"quoted" ${secret:INERT}');
  expect(compiled.pendingSites).toEqual([]);
});
