import { expect, test } from "bun:test";
import type { ExpressionNode } from "@lando/sdk/expressions";
import { renderCompiledRecipeSnapshot, renderRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath, type RecipeSnapshot } from "@lando/sdk/schema";
import { Result } from "effect";

const snapshot = (expression: ExpressionNode): RecipeSnapshot => ({
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
  template: { expression },
});
const context = { appRoot: AbsolutePath.make("/app"), env: {} };
const encoded = (value: string): ExpressionNode => ({
  kind: "Literal",
  value: `lando:authoring:base64:${btoa(value)}`,
});

test.each(["{{ recipe.php }}", "{{ app.name }}", "{{ services.database.creds.password }}", "${secret:DB}"])(
  "preserves encoded authored intent without blessing equal helper or option data: %s",
  (text) => {
    // Given
    const fixture = snapshot({
      kind: "ObjectLiteral",
      entries: [
        {
          key: "services",
          value: {
            kind: "ObjectLiteral",
            entries: [
              {
                key: "web",
                value: {
                  kind: "ObjectLiteral",
                  entries: [
                    {
                      key: "environment",
                      value: {
                        kind: "ObjectLiteral",
                        entries: [
                          { key: "AUTHORED", value: encoded(text) },
                          {
                            key: "BASE64",
                            value: {
                              kind: "Call",
                              callee: "b64decode",
                              args: [{ kind: "Literal", value: btoa(text) }],
                            },
                          },
                          {
                            key: "JSON",
                            value: {
                              kind: "Call",
                              callee: "fromJson",
                              args: [{ kind: "Literal", value: JSON.stringify(text) }],
                            },
                          },
                          {
                            key: "OPTION",
                            value: {
                              kind: "Path",
                              head: "options",
                              segments: [{ type: "prop", name: "text" }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    // When
    const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(fixture, { text }, context));
    const rendered = Result.getOrThrow(renderRecipeSnapshot(fixture, { text }));
    // Then
    expect<unknown>(compiled.document).toEqual(rendered);
    expect(compiled.document).toEqual({
      services: {
        web: {
          environment: {
            AUTHORED: text,
            BASE64: text,
            JSON: text,
            OPTION: text,
          },
        },
      },
    });
    expect(compiled.pendingSites.map((site) => site.path)).toEqual([
      ["services", "web", "environment", "AUTHORED"],
    ]);
  },
);

test("does not interpret a transport marker produced by an option or helper", () => {
  // Given
  const marker = "lando:authoring:base64:JHtzZWNyZXQ6REJ9";
  const fixture = snapshot({
    kind: "ArrayLiteral",
    elements: [
      { kind: "Path", head: "options", segments: [{ type: "prop", name: "marker" }] },
      { kind: "Call", callee: "b64decode", args: [{ kind: "Literal", value: btoa(marker) }] },
    ],
  });
  // When
  const compiled = Result.getOrThrow(renderCompiledRecipeSnapshot(fixture, { marker }, context));
  // Then
  expect(compiled.document).toEqual([marker, marker]);
  expect(compiled.pendingSites).toEqual([]);
});

test("rejects reserved descriptor data produced by a helper", () => {
  // Given
  const fixture = snapshot({
    kind: "Call",
    callee: "fromJson",
    args: [{ kind: "Literal", value: '{"_tag":"SecretRef","reference":"DB"}' }],
  });
  // When
  const compiled = renderCompiledRecipeSnapshot(fixture, {}, context);
  // Then
  expect(Result.isFailure(compiled)).toBe(true);
});
