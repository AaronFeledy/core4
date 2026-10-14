import { SchemaAST as AST, Schema } from "effect";
import {
  type AuthoringExpression,
  type AuthoringExpressionExpectedType,
  authoringExpressionSlot,
  isPlainAuthoringString,
} from "./landofile-authoring-expression.ts";
import { authoringContainerFilter } from "./landofile-authoring-refinement.ts";
import { authoringJsonContainer, authoringWireAst } from "./landofile-authoring-wire.ts";
import { directiveMember } from "./landofile-directive-codec.ts";
import type {
  LandofileOverride,
  LandofileOverrideWire,
  LandofileReset,
  LandofileResetWire,
} from "./landofile-directive.ts";
import { LandofileShape } from "./landofile.ts";

type OverrideWire<T> = ReturnType<typeof LandofileOverrideWire<Schema.Codec<T>>>["Type"];
type ResetWire = typeof LandofileResetWire.Type;

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

type DirectiveAuthoringValue<T> = T extends AuthoringExpression
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DirectiveAuthoringValue<T[K]> }
    : T extends object
      ? {
          readonly [K in keyof T]:
            | DirectiveAuthoringValue<T[K]>
            | LandofileOverride<DirectiveAuthoringValue<T[K]>>
            | LandofileReset;
        }
      : T;
type DirectiveAuthoringEncoded<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DirectiveAuthoringEncoded<T[K]> }
  : T extends object
    ? {
        readonly [K in keyof T]:
          | DirectiveAuthoringEncoded<T[K]>
          | OverrideWire<DirectiveAuthoringEncoded<T[K]>>
          | ResetWire;
      }
    : T;

export type AuthoringDeepPartial<T> = T extends
  | AuthoringExpression
  | LandofileReset
  | LandofileOverride<unknown>
  | ResetWire
  | OverrideWire<unknown>
  | string
  | number
  | boolean
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
  readonly nativeDirectives?: boolean;
  readonly directives?: boolean;
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

const union = (members: ReadonlyArray<AST.AST>, annotations?: Schema.Annotations.Annotations): AST.AST => {
  const flattened = members.flatMap((member) =>
    AST.isUnion(member) && Reflect.ownKeys(member.annotations ?? {}).length === 0 && !member.context
      ? member.types
      : [member],
  );
  return new AST.Union([...new Set(flattened)], undefined, annotations);
};

const authoringAnnotations = (ast: AST.AST, partial: boolean): Schema.Annotations.Annotations | undefined => {
  const identifier = AST.resolveIdentifier(ast);
  return identifier !== undefined
    ? {
        ...AST.resolve(ast),
        identifier: `${identifier}${partial ? "AuthoringFragment" : "Authoring"}`,
      }
    : AST.resolve(ast);
};

const leafKind = (ast: AST.AST): "string" | "number" | "boolean" | undefined => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
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
    const walked = walk(node, allowExpression);
    const contextual = Schema.make<Schema.Codec<unknown>>(walked).annotateKey(
      node.context?.annotations ?? {},
    );
    const result = AST.isOptional(node) ? Schema.optionalKey(contextual).ast : contextual.ast;
    memo.set(node, result);
    return result;
  };
  const member = (node: AST.AST, partialKey = true): AST.AST => {
    const derived = derive(node, true);
    if (!options.directives) return derived;
    const schema = directiveMember(
      Schema.make<Schema.Codec<unknown>>(derived),
      options.nativeDirectives === true,
    );
    return (partialKey && options.partial) || AST.isOptional(derived)
      ? Schema.optionalKey(schema).ast
      : schema.ast;
  };
  const walk = (node: AST.AST, allowExpression: boolean): AST.AST => {
    if (node.encoding !== undefined) return derive(AST.toEncoded(node), allowExpression);
    const kind = leafKind(node);
    if (kind) {
      const leaf =
        kind === "string"
          ? Schema.make<Schema.Codec<string>>(node).check(
              Schema.makeFilter(isPlainAuthoringString, {
                identifier: AST.resolveIdentifier(node),
                title: AST.resolveTitle(node),
                description: AST.resolveDescription(node),
                message: "Expected plain authoring text",
              }),
            ).ast
          : node;
      return allowExpression ? union([leaf, options.slotFor(kind)]) : leaf;
    }
    switch (node._tag) {
      case "Declaration": {
        if (node.annotations?.["lando/map-input"] !== true) return node;
        const project = node.annotations.toCodecJson;
        const projection: unknown = typeof project === "function" ? project(node.typeParameters) : undefined;
        return projection instanceof AST.Link ? derive(projection.to, allowExpression) : node;
      }
      case "Objects": {
        const object = new AST.Objects(
          node.propertySignatures.map(
            (property) =>
              new AST.PropertySignature(
                property.name,
                options.directives
                  ? member(property.type)
                  : options.partial
                    ? Schema.optionalKey(Schema.make<Schema.Codec<unknown>>(derive(property.type, true))).ast
                    : derive(property.type, true),
              ),
          ),
          node.indexSignatures.map(
            (index) =>
              new AST.IndexSignature(
                index.parameter,
                options.directives ? member(index.type, false) : derive(index.type, true),
              ),
          ),
          authoringAnnotations(node, options.partial),
          node.checks && [authoringContainerFilter(node, options.partial)],
          undefined,
          node.context,
        );
        const container = authoringJsonContainer(node, object) ?? object;
        return allowExpression ? union([container, options.slotFor("object")]) : container;
      }
      case "Arrays": {
        const tuple = new AST.Arrays(
          node.isMutable,
          node.elements.map((element) => derive(element, true)),
          node.rest.map((rest) => derive(rest, true)),
          node.annotations,
          node.checks && [authoringContainerFilter(node, options.partial)],
          undefined,
          node.context,
        );
        const container = authoringJsonContainer(node, tuple) ?? tuple;
        return allowExpression ? union([container, options.slotFor("array")]) : container;
      }
      case "Union":
        return union(
          node.types.map((member) => derive(member, allowExpression)),
          authoringAnnotations(node, options.partial),
        );
      case "Suspend":
        return new AST.Suspend(
          () => derive(node.thunk(), allowExpression),
          node.annotations,
          undefined,
          undefined,
          node.context,
        );
      default:
        return node;
    }
  };
  return derive(ast, options.rootExpression ?? true);
};

// ==== Public schemas retain expression source on their encoded side
interface LandofileEncoded extends Schema.Codec.Encoded<typeof LandofileShape> {}
type AuthoringRootValue<T extends object> = { readonly [K in keyof T]: AuthoringValue<T[K]> };
type AuthoringRootEncoded<T extends object> = { readonly [K in keyof T]: AuthoringEncoded<T[K]> };
const slotFor = (kind: AuthoringExpressionExpectedType): AST.AST => authoringExpressionSlot(kind).ast;
const nativeSlotFor = (kind: AuthoringExpressionExpectedType): AST.AST => authoringExpressionSlot(kind).ast;

const authoringSchema = <A, I>(
  derive: () => AST.AST,
  annotations: Schema.Annotations.Annotations = {},
): Schema.Codec<A, I> =>
  Schema.suspend(() =>
    // The suspension owns the public identifier; its payload must not introduce a second definition.
    Schema.make<Schema.Codec<A, I>>(derive()).annotate({ ...annotations, identifier: undefined }),
  ).annotate(annotations);

// Explicit schema types keep declaration emit from expanding the entire Landofile tree.
export const LandofileAuthoringShape: Schema.Codec<
  AuthoringRootValue<LandofileEncoded>,
  AuthoringRootEncoded<LandofileEncoded>
> = authoringSchema(
  () => deriveAuthoringAst(LandofileShape.ast, { partial: false, rootExpression: false, slotFor }),
  {
    identifier: "LandofileAuthoringShape",
    title: "Landofile authoring shape",
    description:
      "Complete Landofile authoring values with parsed, unresolved expressions at typed value sites.",
  },
);

export const LandofileAuthoringFragment: Schema.Codec<
  AuthoringDeepPartial<DirectiveAuthoringValue<AuthoringValue<LandofileEncoded>>>,
  AuthoringDeepPartial<DirectiveAuthoringEncoded<AuthoringEncoded<LandofileEncoded>>>
> = authoringSchema(
  () => deriveAuthoringAst(LandofileShape.ast, { partial: true, slotFor, directives: true }),
  {
    identifier: "LandofileAuthoringFragment",
    title: "Landofile authoring fragment",
    description:
      "Recursively partial Landofile authoring values with parsed, unresolved expressions at typed value sites.",
  },
);

export const LandofileAuthoringFragmentNative: Schema.Codec<typeof LandofileAuthoringFragment.Type, unknown> =
  authoringSchema(() =>
    deriveAuthoringAst(LandofileShape.ast, {
      partial: true,
      rootExpression: false,
      slotFor: nativeSlotFor,
      directives: true,
      nativeDirectives: true,
    }),
  );

export const LandofileAuthoringShapeWire: Schema.Codec<AuthoringRootEncoded<LandofileEncoded>> =
  authoringSchema(() => authoringWireAst(LandofileAuthoringShape.ast), {
    identifier: "LandofileAuthoringShapeWire",
    title: "Landofile authoring shape wire form",
    description: "Complete Landofile authoring wire tree retaining expressions as source strings.",
  });

export const LandofileAuthoringFragmentWire: Schema.Codec<
  AuthoringDeepPartial<DirectiveAuthoringEncoded<AuthoringEncoded<LandofileEncoded>>>
> = authoringSchema(() => authoringWireAst(LandofileAuthoringFragment.ast), {
  identifier: "LandofileAuthoringFragmentWire",
  title: "Landofile authoring fragment wire form",
  description: "Recursively partial Landofile authoring wire tree retaining expressions as source strings.",
});
