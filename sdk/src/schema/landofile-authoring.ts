import { SchemaAST as AST, Option, ParseResult, Schema } from "effect";
import {
  type AuthoringExpression,
  type AuthoringExpressionExpectedType,
  authoringExpressionSlot,
  isPlainAuthoringString,
} from "./landofile-authoring-expression.ts";
import { LandofileShape } from "./landofile.ts";

// ==== Generic wire-tree authoring types
export type AuthoringValue<T> = T extends AuthoringExpression
  ? T
  : T extends string | number | boolean
    ? T | AuthoringExpression
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: AuthoringValue<T[K]> } | AuthoringExpression
      : T extends object
        ? { readonly [K in keyof T]: AuthoringValue<T[K]> } | AuthoringExpression
        : T;

export type AuthoringEncoded<T> = T extends string
  ? string
  : T extends number | boolean
    ? T | string
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: AuthoringEncoded<T[K]> } | string
      : T extends object
        ? { readonly [K in keyof T]: AuthoringEncoded<T[K]> } | string
        : T;

export type AuthoringDeepPartial<T> = T extends AuthoringExpression | string | number | boolean
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: AuthoringDeepPartial<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]?: AuthoringDeepPartial<T[K]> | undefined }
      : T;

// ==== Memoized authoring projection
export interface DeriveAuthoringOptions {
  readonly partial: boolean;
  readonly slotFor: (kind: AuthoringExpressionExpectedType) => AST.AST;
}

const caches = new WeakMap<
  DeriveAuthoringOptions["slotFor"],
  readonly [WeakMap<AST.AST, AST.AST>, WeakMap<AST.AST, AST.AST>]
>();

const union = (members: ReadonlyArray<AST.AST>, annotations?: AST.Annotations): AST.AST => {
  const flattened = members.flatMap((member) =>
    AST.isUnion(member) && Reflect.ownKeys(member.annotations).length === 0 ? member.types : [member],
  );
  return AST.Union.make([...new Set(flattened)], annotations);
};

const authoringAnnotations = (ast: AST.AST, partial: boolean): AST.Annotations => {
  const identifier = AST.getIdentifierAnnotation(ast);
  return Option.isSome(identifier)
    ? {
        ...ast.annotations,
        [AST.IdentifierAnnotationId]: `${identifier.value}${partial ? "AuthoringFragment" : "Authoring"}`,
      }
    : ast.annotations;
};

const leafKind = (ast: AST.AST): "string" | "number" | "boolean" | undefined => {
  switch (ast._tag) {
    case "Refinement":
      return leafKind(ast.from);
    case "StringKeyword":
    case "TemplateLiteral":
      return "string";
    case "NumberKeyword":
      return "number";
    case "BooleanKeyword":
      return "boolean";
    case "Literal": {
      switch (typeof ast.literal) {
        case "string":
          return "string";
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
};

export const deriveAuthoringAst = (ast: AST.AST, options: DeriveAuthoringOptions): AST.AST => {
  let pair = caches.get(options.slotFor);
  if (!pair) {
    pair = [new WeakMap(), new WeakMap()];
    caches.set(options.slotFor, pair);
  }
  const memo = pair[options.partial ? 1 : 0];
  const derive = (node: AST.AST): AST.AST => {
    const cached = memo.get(node);
    if (cached) return cached;
    const result = walk(node);
    memo.set(node, result);
    return result;
  };
  const walk = (node: AST.AST): AST.AST => {
    const kind = leafKind(node);
    if (kind) {
      const leaf =
        kind === "string"
          ? new AST.Refinement(node, (input: string, _options, self) =>
              isPlainAuthoringString(input)
                ? Option.none()
                : Option.some(new ParseResult.Type(self, input, "Expected plain authoring text")),
            )
          : node;
      return union([leaf, options.slotFor(kind)]);
    }
    switch (node._tag) {
      case "Transformation":
        return derive(node.from);
      case "Refinement":
        return AST.annotations(derive(node.from), authoringAnnotations(node, options.partial));
      case "TypeLiteral": {
        const object = new AST.TypeLiteral(
          node.propertySignatures.map(
            (property) =>
              new AST.PropertySignature(
                property.name,
                options.partial
                  ? union([derive(property.type), AST.undefinedKeyword])
                  : derive(property.type),
                options.partial || property.isOptional,
                property.isReadonly,
                property.annotations,
              ),
          ),
          node.indexSignatures.map(
            (index) => new AST.IndexSignature(index.parameter, derive(index.type), index.isReadonly),
          ),
          authoringAnnotations(node, options.partial),
        );
        return union([object, options.slotFor("object")]);
      }
      case "TupleType":
        return union([
          new AST.TupleType(
            node.elements.map(
              (element) =>
                new AST.OptionalType(derive(element.type), element.isOptional, element.annotations),
            ),
            node.rest.map((rest) => new AST.Type(derive(rest.type), rest.annotations)),
            node.isReadonly,
            node.annotations,
          ),
          options.slotFor("array"),
        ]);
      case "Union":
        return union(node.types.map(derive), authoringAnnotations(node, options.partial));
      case "Suspend":
        return new AST.Suspend(() => derive(node.f()), node.annotations);
      default:
        return node;
    }
  };
  return derive(ast);
};

// ==== Public schemas retain expression source on their encoded side
interface LandofileEncoded extends Schema.Schema.Encoded<typeof LandofileShape> {}
const slotFor = (kind: AuthoringExpressionExpectedType): AST.AST => authoringExpressionSlot(kind).ast;

// Explicit schema types keep declaration emit from expanding the entire Landofile tree.
export const LandofileAuthoringShape: Schema.Schema<
  AuthoringValue<LandofileEncoded>,
  AuthoringEncoded<LandofileEncoded>
> = Schema.make<AuthoringValue<LandofileEncoded>, AuthoringEncoded<LandofileEncoded>>(
  deriveAuthoringAst(LandofileShape.ast, { partial: false, slotFor }),
).annotations({
  identifier: "LandofileAuthoringShape",
  title: "Landofile authoring shape",
  description:
    "Complete Landofile authoring values with parsed, unresolved expressions at typed value sites.",
});

export const LandofileAuthoringFragment: Schema.Schema<
  AuthoringDeepPartial<AuthoringValue<LandofileEncoded>>,
  AuthoringDeepPartial<AuthoringEncoded<LandofileEncoded>>
> = Schema.make<
  AuthoringDeepPartial<AuthoringValue<LandofileEncoded>>,
  AuthoringDeepPartial<AuthoringEncoded<LandofileEncoded>>
>(deriveAuthoringAst(LandofileShape.ast, { partial: true, slotFor })).annotations({
  identifier: "LandofileAuthoringFragment",
  title: "Landofile authoring fragment",
  description:
    "Recursively partial Landofile authoring values with parsed, unresolved expressions at typed value sites.",
});

export const LandofileAuthoringShapeWire: Schema.Schema<AuthoringEncoded<LandofileEncoded>> =
  Schema.encodedSchema(LandofileAuthoringShape).annotations({
    identifier: "LandofileAuthoringShapeWire",
    title: "Landofile authoring shape wire form",
    description: "Complete Landofile authoring wire tree retaining expressions as source strings.",
  });

export const LandofileAuthoringFragmentWire: Schema.Schema<
  AuthoringDeepPartial<AuthoringEncoded<LandofileEncoded>>
> = Schema.encodedSchema(LandofileAuthoringFragment).annotations({
  identifier: "LandofileAuthoringFragmentWire",
  title: "Landofile authoring fragment wire form",
  description: "Recursively partial Landofile authoring wire tree retaining expressions as source strings.",
});
