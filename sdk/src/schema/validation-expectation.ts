import { SchemaAST } from "effect";
import { authoringExpectation, isExpressionSlot } from "./authoring-issue-metadata.ts";
import { isMergeDirectiveMemberAst } from "./landofile-directive.ts";

const expectations = new WeakMap<SchemaAST.AST, string>();

const phrase = (original: SchemaAST.AST, seen: Set<SchemaAST.AST>): string => {
  const ast = authoringExpectation(original);
  const cached = expectations.get(ast);
  if (cached !== undefined) return cached;
  if (typeof ast.annotations?.expected === "string") return ast.annotations.expected;
  if (seen.has(ast)) return "a value";
  seen.add(ast);
  const child = (member: SchemaAST.AST) => phrase(member, new Set(seen));
  let expected: string;
  switch (ast._tag) {
    case "Union":
      expected = [
        ...new Set(
          ast.types
            .filter((member) => !isExpressionSlot(member) && !isMergeDirectiveMemberAst(member))
            .map((member) => child(SchemaAST.toEncoded(member))),
        ),
      ].join(" | ");
      break;
    case "Suspend":
      expected = child(ast.thunk());
      break;
    case "Declaration":
      expected = ast.annotations?.["lando/map-input"] === true ? "object" : "a valid value";
      break;
    case "Literal":
      expected = typeof ast.literal === "bigint" ? `${ast.literal}n` : JSON.stringify(ast.literal);
      break;
    case "UniqueSymbol":
    case "Symbol":
      expected = "symbol";
      break;
    case "Enum":
      expected = [...new Set(ast.enums.map((entry) => JSON.stringify(entry[1])))].join(" | ");
      break;
    case "Objects":
    case "ObjectKeyword":
      expected = "object";
      break;
    case "Arrays":
      expected = "array";
      break;
    case "TemplateLiteral":
      expected = "a matching string";
      break;
    case "String":
      expected = "string";
      break;
    case "Number":
      expected = "number";
      break;
    case "Boolean":
      expected = "boolean";
      break;
    case "BigInt":
      expected = "bigint";
      break;
    case "Null":
      expected = "null";
      break;
    case "Undefined":
      expected = "undefined";
      break;
    case "Void":
      expected = "void";
      break;
    case "Never":
      expected = "never";
      break;
    case "Unknown":
      expected = "unknown";
      break;
    case "Any":
      expected = "any";
      break;
    default:
      return ast satisfies never;
  }
  expectations.set(ast, expected);
  return expected;
};

export const validationExpectation = (original: SchemaAST.AST): string => {
  const ast = authoringExpectation(original);
  return typeof ast.annotations?.message === "string"
    ? ast.annotations.message
    : `Expected ${phrase(ast, new Set())}`;
};
