import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { resolveConstString, scanComments, scanLiterals } from "../../../../scripts/boundary/literals.ts";

const sourceFile = (text: string): ts.SourceFile =>
  ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

describe("boundary literal scanner", () => {
  test("finds strings, template parts, and regular-expression literals with positions", () => {
    // Given
    const source = sourceFile(
      [
        'const name = "world";',
        "const plain = 'plain';",
        "const fixed = `fixed`;",
        'const message = `hello ${name} tail ${"!"} end`;',
        "const matcher = /bearer\\s+/gi;",
      ].join("\n"),
    );

    // When
    const literals = scanLiterals(source);

    // Then
    expect(literals.map(({ kind, value }) => ({ kind, value }))).toEqual(
      expect.arrayContaining([
        { kind: "string", value: "world" },
        { kind: "string", value: "plain" },
        { kind: "string", value: "fixed" },
        { kind: "template-part", value: "hello " },
        { kind: "template-part", value: " tail " },
        { kind: "template-part", value: " end" },
        { kind: "regex", value: "/bearer\\s+/gi" },
      ]),
    );
    expect(literals.every(({ start, end }) => start >= 0 && end > start)).toBe(true);
  });

  test("finds file-head, trailing line, and block comments", () => {
    // Given
    const source = sourceFile(
      ["// file head", "const value = 1; // trailing", "/* block comment */", "export { value };"].join("\n"),
    );

    // When
    const comments = scanComments(source);

    // Then
    expect(comments.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "line-comment", value: "// file head" },
      { kind: "line-comment", value: "// trailing" },
      { kind: "block-comment", value: "/* block comment */" },
    ]);
  });

  test("const-folds concatenations and templates through const bindings", () => {
    // Given
    const source = sourceFile(
      ['const scope = "@lando/";', 'const name = "sdk";', "const target = scope + `${name}/probe`;"].join(
        "\n",
      ),
    );
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((item) => ts.isIdentifier(item.name) && item.name.text === "target");

    // When
    const resolved = declaration?.initializer
      ? resolveConstString(declaration.initializer, source)
      : undefined;

    // Then
    expect(resolved).toBe("@lando/sdk/probe");
  });
});
