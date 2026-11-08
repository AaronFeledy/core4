import { type SchemaAST as AST, Schema } from "effect";
import { deriveAuthoringAst } from "./landofile-authoring-ast.ts";
import {
  type AuthoringExpression,
  type AuthoringExpressionExpectedType,
  authoringExpressionSlot,
} from "./landofile-authoring-expression.ts";
import { authoringWireAst } from "./landofile-authoring-wire.ts";
import type {
  LandofileOverride,
  LandofileOverrideWire,
  LandofileReset,
  LandofileResetWire,
} from "./landofile-directive.ts";
import { LandofileShape } from "./landofile.ts";

export { type DeriveAuthoringOptions, deriveAuthoringAst } from "./landofile-authoring-ast.ts";

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
