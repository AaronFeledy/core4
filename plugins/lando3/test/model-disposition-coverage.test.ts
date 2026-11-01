import { expect, test } from "bun:test";
import { SchemaAST } from "effect";
import { Lando3LandofileShape } from "../src/model.ts";
import { dispositionInventory } from "./fixtures/disposition-inventory.ts";

const fields = (ast: SchemaAST.AST, path: readonly string[] = []): readonly (readonly string[])[] => {
  if (ast.encoding !== undefined) return fields(SchemaAST.toEncoded(ast), path);
  switch (ast._tag) {
    case "Suspend":
      return fields(ast.thunk(), path);
    case "Union": {
      const objects = ast.types.filter(
        (member) => member._tag === "Objects" && member.propertySignatures.length > 0,
      );
      return (objects.length > 0 ? objects : ast.types).flatMap((member) => fields(member, path));
    }
    case "Objects": {
      if (ast.propertySignatures.length > 0)
        return ast.propertySignatures.flatMap((field) => fields(field.type, [...path, String(field.name)]));
      return ast.indexSignatures.length > 0
        ? ast.indexSignatures.flatMap((entry) => fields(entry.type, [...path, "*"]))
        : [path];
    }
    case "Arrays":
      return [...ast.elements, ...ast.rest].flatMap((entry) => fields(entry, [...path, "*"]));
    default:
      return [path];
  }
};

test("has an inventory row for every recognized model leaf", () => {
  // Given the complete schema AST, including all service union branches.
  const namedPath = (path: readonly string[]): readonly string[] => {
    const lastNamed = path.findLastIndex((key) => key !== "*");
    return path.slice(0, lastNamed + 1);
  };
  const paths = new Set(fields(Lando3LandofileShape.ast).map((path) => JSON.stringify(namedPath(path))));
  const inventoried = new Set(dispositionInventory.map(({ pattern }) => JSON.stringify(namedPath(pattern))));
  // When matching leaf obligations against independently authored inventory rows.
  const missing = [...paths].filter((path) => !inventoried.has(path));
  // Then a new recognized field cannot be added without a disposition golden.
  expect(missing).toEqual([]);
});
