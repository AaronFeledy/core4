import { Schema } from "effect";

export interface LiteralExpressionNode {
  readonly kind: "Literal";
  readonly value: string | number | boolean | null;
}

export interface ArrayLiteralExpressionNode {
  readonly kind: "ArrayLiteral";
  readonly elements: ReadonlyArray<ExpressionNode>;
}

export interface ObjectLiteralEntry {
  readonly key: string;
  readonly value: ExpressionNode;
}

export interface ObjectLiteralExpressionNode {
  readonly kind: "ObjectLiteral";
  readonly entries: ReadonlyArray<ObjectLiteralEntry>;
}

export interface PropPathSegment {
  readonly type: "prop";
  readonly name: string;
}

export interface IndexPathSegment {
  readonly type: "index";
  readonly index: number;
}

export interface KeyPathSegment {
  readonly type: "key";
  readonly key: string;
}

export interface DynamicPathSegment {
  readonly type: "dynamic";
  readonly expr: ExpressionNode;
}

export type PathSegment = PropPathSegment | IndexPathSegment | KeyPathSegment | DynamicPathSegment;

export interface PathExpressionNode {
  readonly kind: "Path";
  readonly head: string;
  readonly segments: ReadonlyArray<PathSegment>;
}

export interface CallExpressionNode {
  readonly kind: "Call";
  readonly callee: string;
  readonly args: ReadonlyArray<ExpressionNode>;
}

export interface ConditionalExpressionNode {
  readonly kind: "Conditional";
  readonly test: ExpressionNode;
  readonly consequent: ExpressionNode;
  readonly alternate: ExpressionNode;
}

export type ExpressionNode =
  | LiteralExpressionNode
  | ArrayLiteralExpressionNode
  | ObjectLiteralExpressionNode
  | PathExpressionNode
  | CallExpressionNode
  | ConditionalExpressionNode;

export interface LiteralSegment {
  readonly kind: "LiteralSegment";
  readonly text: string;
}

export interface InterpolationSegment {
  readonly kind: "InterpolationSegment";
  readonly expression: ExpressionNode;
  readonly trimLeft: boolean;
  readonly trimRight: boolean;
}

export interface CommentSegment {
  readonly kind: "CommentSegment";
  readonly text: string;
}

export type ShellParamOperator = "plain" | "default-empty" | "default-unset" | "error" | "alt";

export interface ShellParamSegment {
  readonly kind: "ShellParamSegment";
  readonly name: string;
  readonly operator: ShellParamOperator;
  readonly word?: string | undefined;
}

export interface SecretRefSegment {
  readonly kind: "SecretRefSegment";
  readonly name: string;
}

export type ExpressionSegment =
  | LiteralSegment
  | InterpolationSegment
  | CommentSegment
  | ShellParamSegment
  | SecretRefSegment;

export interface ExpressionTemplate {
  readonly whole: boolean;
  readonly segments: ReadonlyArray<ExpressionSegment>;
}

export const LiteralExpressionNode: Schema.Schema<LiteralExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Literal"),
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
});

export const PropPathSegment: Schema.Schema<PropPathSegment> = Schema.Struct({
  type: Schema.Literal("prop"),
  name: Schema.String,
});

export const IndexPathSegment: Schema.Schema<IndexPathSegment> = Schema.Struct({
  type: Schema.Literal("index"),
  index: Schema.Number,
});

export const KeyPathSegment: Schema.Schema<KeyPathSegment> = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
});

export const DynamicPathSegment: Schema.Schema<DynamicPathSegment> = Schema.Struct({
  type: Schema.Literal("dynamic"),
  expr: Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode),
});

export const PathSegment: Schema.Schema<PathSegment> = Schema.Union(
  PropPathSegment,
  IndexPathSegment,
  KeyPathSegment,
  DynamicPathSegment,
);

export const ArrayLiteralExpressionNode: Schema.Schema<ArrayLiteralExpressionNode> = Schema.Struct({
  kind: Schema.Literal("ArrayLiteral"),
  elements: Schema.Array(Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode)),
});

export const ObjectLiteralEntry: Schema.Schema<ObjectLiteralEntry> = Schema.Struct({
  key: Schema.String,
  value: Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode),
});

export const ObjectLiteralExpressionNode: Schema.Schema<ObjectLiteralExpressionNode> = Schema.Struct({
  kind: Schema.Literal("ObjectLiteral"),
  entries: Schema.Array(ObjectLiteralEntry),
});

export const PathExpressionNode: Schema.Schema<PathExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Path"),
  head: Schema.String,
  segments: Schema.Array(PathSegment),
});

export const CallExpressionNode: Schema.Schema<CallExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Call"),
  callee: Schema.String,
  args: Schema.Array(Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode)),
});

export const ConditionalExpressionNode: Schema.Schema<ConditionalExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Conditional"),
  test: Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode),
  consequent: Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode),
  alternate: Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode),
});

export const ExpressionNode: Schema.Schema<ExpressionNode> = Schema.suspend(
  (): Schema.Schema<ExpressionNode> =>
    Schema.Union(
      LiteralExpressionNode,
      ArrayLiteralExpressionNode,
      ObjectLiteralExpressionNode,
      PathExpressionNode,
      CallExpressionNode,
      ConditionalExpressionNode,
    ),
);

export const LiteralSegment: Schema.Schema<LiteralSegment> = Schema.Struct({
  kind: Schema.Literal("LiteralSegment"),
  text: Schema.String,
});

export const InterpolationSegment: Schema.Schema<InterpolationSegment> = Schema.Struct({
  kind: Schema.Literal("InterpolationSegment"),
  expression: Schema.suspend((): Schema.Schema<ExpressionNode> => ExpressionNode),
  trimLeft: Schema.Boolean,
  trimRight: Schema.Boolean,
});

export const CommentSegment: Schema.Schema<CommentSegment> = Schema.Struct({
  kind: Schema.Literal("CommentSegment"),
  text: Schema.String,
});

export const ShellParamOperator = Schema.Literal("plain", "default-empty", "default-unset", "error", "alt");
export const ShellParamSegment: Schema.Schema<ShellParamSegment> = Schema.Struct({
  kind: Schema.Literal("ShellParamSegment"),
  name: Schema.String,
  operator: ShellParamOperator,
  word: Schema.optional(Schema.String),
});

export const SecretRefSegment: Schema.Schema<SecretRefSegment> = Schema.Struct({
  kind: Schema.Literal("SecretRefSegment"),
  name: Schema.String,
});

export const ExpressionSegment: Schema.Schema<ExpressionSegment> = Schema.Union(
  LiteralSegment,
  InterpolationSegment,
  CommentSegment,
  ShellParamSegment,
  SecretRefSegment,
);

export const ExpressionTemplate: Schema.Schema<ExpressionTemplate> = Schema.Struct({
  whole: Schema.Boolean,
  segments: Schema.Array(ExpressionSegment),
});
