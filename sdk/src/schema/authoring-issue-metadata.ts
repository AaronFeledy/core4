import type { SchemaAST } from "effect";

// Diagnostic provenance must not affect union flattening, identity, or JSON Schema.
const sources = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const expectations = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const slots = new WeakSet<SchemaAST.AST>();
const directiveValues = new WeakMap<SchemaAST.Union["types"], SchemaAST.AST>();

export const recordAuthoringSource = (derived: SchemaAST.AST, source: SchemaAST.AST): void => {
  if (derived === source) return;
  sources.set(derived, source);
  if (expectations.has(source)) return;
  // Map-input declarations are always candidates; their record parser owns type failures.
  const fallback =
    source._tag === "Union" && typeof source.annotations?.message !== "string"
      ? source.types.find(
          (member) => member._tag === "Declaration" && member.annotations?.["lando/map-input"] === true,
        )
      : undefined;
  expectations.set(
    source,
    fallback?._tag === "Declaration" ? (fallback.typeParameters[0] ?? source) : source,
  );
};

export const authoringSource = (ast: SchemaAST.AST): SchemaAST.AST | undefined => sources.get(ast);

export const authoringExpectation = (ast: SchemaAST.AST): SchemaAST.AST =>
  expectations.get(sources.get(ast) ?? ast) ?? ast;

export const recordExpressionSlot = (ast: SchemaAST.AST): void => {
  slots.add(ast);
};

export const isExpressionSlot = (ast: SchemaAST.AST): boolean => slots.has(ast);

export const recordDirectiveUnion = (ast: SchemaAST.Union, value: SchemaAST.AST): void => {
  directiveValues.set(ast.types, value);
};

export const directiveValue = (ast: SchemaAST.Union): SchemaAST.AST | undefined =>
  directiveValues.get(ast.types);

export const PLAIN_TEXT_SLOT_REJECTION = "lando/authoring/plain-text-slot-rejection";
