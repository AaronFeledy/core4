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

export interface AccessExpressionNode {
  readonly kind: "Access";
  readonly target: ExpressionNode;
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
  | AccessExpressionNode
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

export const LiteralExpressionNode: Schema.Codec<LiteralExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Literal"),
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
});

export const PropPathSegment: Schema.Codec<PropPathSegment> = Schema.Struct({
  type: Schema.Literal("prop"),
  name: Schema.String,
});

export const IndexPathSegment: Schema.Codec<IndexPathSegment> = Schema.Struct({
  type: Schema.Literal("index"),
  index: Schema.Number,
});

export const KeyPathSegment: Schema.Codec<KeyPathSegment> = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
});

export const DynamicPathSegment: Schema.Codec<DynamicPathSegment> = Schema.Struct({
  type: Schema.Literal("dynamic"),
  expr: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
});

export const PathSegment: Schema.Codec<PathSegment> = Schema.Union([PropPathSegment, IndexPathSegment, KeyPathSegment, DynamicPathSegment]);

export const ArrayLiteralExpressionNode: Schema.Codec<ArrayLiteralExpressionNode> = Schema.Struct({
  kind: Schema.Literal("ArrayLiteral"),
  elements: Schema.Array(
    Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
      identifier: "ExpressionNode",
    }),
  ),
});

export const ObjectLiteralEntry: Schema.Codec<ObjectLiteralEntry> = Schema.Struct({
  key: Schema.String,
  value: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
});

export const ObjectLiteralExpressionNode: Schema.Codec<ObjectLiteralExpressionNode> = Schema.Struct({
  kind: Schema.Literal("ObjectLiteral"),
  entries: Schema.Array(ObjectLiteralEntry),
});

export const PathExpressionNode: Schema.Codec<PathExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Path"),
  head: Schema.String,
  segments: Schema.Array(PathSegment),
});

export const AccessExpressionNode: Schema.Codec<AccessExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Access"),
  target: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
  segments: Schema.Array(PathSegment),
});

export const CallExpressionNode: Schema.Codec<CallExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Call"),
  callee: Schema.String,
  args: Schema.Array(
    Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
      identifier: "ExpressionNode",
    }),
  ),
});

export const ConditionalExpressionNode: Schema.Codec<ConditionalExpressionNode> = Schema.Struct({
  kind: Schema.Literal("Conditional"),
  test: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
  consequent: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
  alternate: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
});

export const ExpressionNode: Schema.Codec<ExpressionNode> = Schema.suspend(
  (): Schema.Codec<ExpressionNode> =>
    Schema.Union([LiteralExpressionNode, ArrayLiteralExpressionNode, ObjectLiteralExpressionNode, PathExpressionNode, AccessExpressionNode, CallExpressionNode, ConditionalExpressionNode]),
).annotate({ identifier: "ExpressionNode" });

export const LiteralSegment: Schema.Codec<LiteralSegment> = Schema.Struct({
  kind: Schema.Literal("LiteralSegment"),
  text: Schema.String,
});

export const InterpolationSegment: Schema.Codec<InterpolationSegment> = Schema.Struct({
  kind: Schema.Literal("InterpolationSegment"),
  expression: Schema.suspend((): Schema.Codec<ExpressionNode> => ExpressionNode).annotate({
    identifier: "ExpressionNode",
  }),
  trimLeft: Schema.Boolean,
  trimRight: Schema.Boolean,
});

export const CommentSegment: Schema.Codec<CommentSegment> = Schema.Struct({
  kind: Schema.Literal("CommentSegment"),
  text: Schema.String,
});

export const ShellParamOperator = Schema.Literals(["plain", "default-empty", "default-unset", "error", "alt"]);
export const ShellParamSegment: Schema.Codec<ShellParamSegment> = Schema.Struct({
  kind: Schema.Literal("ShellParamSegment"),
  name: Schema.String,
  operator: ShellParamOperator,
  word: Schema.optionalKey(Schema.String),
});

export const SecretRefSegment: Schema.Codec<SecretRefSegment> = Schema.Struct({
  kind: Schema.Literal("SecretRefSegment"),
  name: Schema.String,
});

export const ExpressionSegment: Schema.Codec<ExpressionSegment> = Schema.Union([LiteralSegment, InterpolationSegment, CommentSegment, ShellParamSegment, SecretRefSegment]);

export const ExpressionTemplate: Schema.Codec<ExpressionTemplate> = Schema.Struct({
  whole: Schema.Boolean,
  segments: Schema.Array(ExpressionSegment),
});
