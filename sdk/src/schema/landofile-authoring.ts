import { SchemaAST as AST, Option, ParseResult, Schema } from "effect";
import {
  type AuthoringExpression,
  type AuthoringExpressionExpectedType,
  authoringExpressionSlot,
  isPlainAuthoringString,
} from "./landofile-authoring-expression.ts";
import { authoringContainerFilter, containerKind } from "./landofile-authoring-refinement.ts";
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
  readonly rootExpression?: boolean;
}

const caches = new WeakMap<
  DeriveAuthoringOptions["slotFor"],
  readonly [
    WeakMap<AST.AST, AST.AST>,
    WeakMap<AST.AST, AST.AST>,
    WeakMap<AST.AST, AST.AST>,
    WeakMap<AST.AST, AST.AST>,
  ]
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
    pair = [new WeakMap(), new WeakMap(), new WeakMap(), new WeakMap()];
    caches.set(options.slotFor, pair);
  }
  const derive = (node: AST.AST, allowExpression: boolean): AST.AST => {
    const memo = options.partial
      ? allowExpression
        ? pair[3]
        : pair[2]
      : allowExpression
        ? pair[1]
        : pair[0];
    const cached = memo.get(node);
    if (cached) return cached;
    const result = walk(node, allowExpression);
    memo.set(node, result);
    return result;
  };
  const walk = (node: AST.AST, allowExpression: boolean): AST.AST => {
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
      return allowExpression ? union([leaf, options.slotFor(kind)]) : leaf;
    }
    switch (node._tag) {
      case "Transformation":
        return derive(node.from, allowExpression);
      case "Refinement": {
        const refined = new AST.Refinement(
          derive(node.from, false),
          authoringContainerFilter(node, options.partial),
          authoringAnnotations(node, options.partial),
        );
        const kind = containerKind(node.from);
        return allowExpression && kind !== undefined ? union([refined, options.slotFor(kind)]) : refined;
      }
      case "TypeLiteral": {
        const object = new AST.TypeLiteral(
          node.propertySignatures.map(
            (property) =>
              new AST.PropertySignature(
                property.name,
                options.partial
                  ? union([derive(property.type, true), AST.undefinedKeyword])
                  : derive(property.type, true),
                options.partial || property.isOptional,
                property.isReadonly,
                property.annotations,
              ),
          ),
          node.indexSignatures.map(
            (index) => new AST.IndexSignature(index.parameter, derive(index.type, true), index.isReadonly),
          ),
          authoringAnnotations(node, options.partial),
        );
        return allowExpression ? union([object, options.slotFor("object")]) : object;
      }
      case "TupleType": {
        const tuple = new AST.TupleType(
          node.elements.map(
            (element) =>
              new AST.OptionalType(derive(element.type, true), element.isOptional, element.annotations),
          ),
          node.rest.map((rest) => new AST.Type(derive(rest.type, true), rest.annotations)),
          node.isReadonly,
          node.annotations,
        );
        return allowExpression ? union([tuple, options.slotFor("array")]) : tuple;
      }
      case "Union":
        return union(
          node.types.map((member) => derive(member, allowExpression)),
          authoringAnnotations(node, options.partial),
        );
      case "Suspend":
        return new AST.Suspend(() => derive(node.f(), allowExpression), node.annotations);
      default:
        return node;
    }
  };
  return derive(ast, options.rootExpression ?? true);
};

// ==== Public schemas retain expression source on their encoded side
interface LandofileEncoded extends Schema.Schema.Encoded<typeof LandofileShape> {}
type AuthoringRootValue<T extends object> = { readonly [K in keyof T]: AuthoringValue<T[K]> };
type AuthoringRootEncoded<T extends object> = { readonly [K in keyof T]: AuthoringEncoded<T[K]> };
const slotFor = (kind: AuthoringExpressionExpectedType): AST.AST => authoringExpressionSlot(kind).ast;

// Explicit schema types keep declaration emit from expanding the entire Landofile tree.
export const LandofileAuthoringShape: Schema.Schema<
  AuthoringRootValue<LandofileEncoded>,
  AuthoringRootEncoded<LandofileEncoded>
> = Schema.make<AuthoringRootValue<LandofileEncoded>, AuthoringRootEncoded<LandofileEncoded>>(
  deriveAuthoringAst(LandofileShape.ast, { partial: false, rootExpression: false, slotFor }),
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

export const LandofileAuthoringShapeWire: Schema.Schema<AuthoringRootEncoded<LandofileEncoded>> =
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
