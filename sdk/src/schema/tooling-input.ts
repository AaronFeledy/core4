import { Schema } from "effect";
import { DeprecationNotice } from "./deprecation.ts";
import { ToolingVarLiteral } from "./primitives.ts";

// ==== Authored input declarations
export const ToolingFlagShape = Schema.Struct({
  alias: Schema.optionalKey(Schema.String).annotate({ description: "Optional single-token flag alias." }),
  choices: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Allowed flag values." }),
  boolean: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether the flag is a boolean switch.",
  }),
  required: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether the flag must be supplied.",
  }),
  sensitive: Schema.optionalKey(Schema.Literal(true)).annotate({
    description: "Protect supplied values from observable output; secret-like names are always protected.",
  }),
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(ToolingVarLiteral),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type ToolingFlagShape = typeof ToolingFlagShape.Type;

export const ToolingArgShape = Schema.Struct({
  choices: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Allowed argument values.",
  }),
  order: Schema.optionalKey(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ).annotate({ description: "Positional declaration order." }),
  sensitive: Schema.optionalKey(Schema.Literal(true)).annotate({
    description: "Protect supplied values from observable output; secret-like names are always protected.",
  }),
  description: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(ToolingVarLiteral),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type ToolingArgShape = typeof ToolingArgShape.Type;

export const ToolingAuthoredInputFields = {
  flags: Schema.optionalKey(Schema.Record(Schema.String, ToolingFlagShape)).annotate({
    description: "Named flags accepted by tooling.",
  }),
  args: Schema.optionalKey(Schema.Record(Schema.String, ToolingArgShape)).annotate({
    description: "Named positional arguments accepted by tooling.",
  }),
  arguments: Schema.optionalKey(Schema.Literal(false)).annotate({
    description: "Reject caller-supplied positional arguments.",
  }),
};

// ==== Canonical normalized declaration and invocation protocol
const normalizedFlagFields = {
  name: Schema.String.annotate({ description: "Canonical declared flag name." }),
  alias: Schema.optionalKey(Schema.String).annotate({ description: "Alternate short argv spelling." }),
  required: Schema.Boolean.annotate({ description: "Whether omission is refused." }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "Presentation-only help text." }),
};
const sensitiveInputFields = {
  sensitive: Schema.Literal(true).annotate({
    description: "Effective explicit or name-derived sensitivity.",
  }),
  default: Schema.optionalKey(Schema.Never).annotate({ description: "Sensitive inputs prohibit defaults." }),
  choices: Schema.optionalKey(Schema.Never).annotate({ description: "Sensitive inputs prohibit choices." }),
};
const publicInputFields = {
  sensitive: Schema.Literal(false).annotate({
    description: "Effective explicit or name-derived sensitivity.",
  }),
};
const stringInputFields = {
  ...publicInputFields,
  choices: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Allowed literal string values.",
  }),
  default: Schema.optionalKey(Schema.String).annotate({
    description: "Value bound only when the input is absent.",
  }),
};
export const NormalizedToolingFlag = Schema.Union([
  Schema.Struct({
    ...normalizedFlagFields,
    ...sensitiveInputFields,
    boolean: Schema.Boolean.annotate({ description: "Whether values are boolean rather than string." }),
  }),
  Schema.Struct({
    ...normalizedFlagFields,
    ...publicInputFields,
    boolean: Schema.Literal(true).annotate({ description: "Values are boolean switches." }),
    choices: Schema.optionalKey(Schema.Never).annotate({ description: "Boolean flags prohibit choices." }),
    default: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Value bound only when the flag is absent.",
    }),
  }),
  Schema.Struct({
    ...normalizedFlagFields,
    ...stringInputFields,
    boolean: Schema.Literal(false).annotate({ description: "Values are literal strings." }),
  }),
]).annotate({
  identifier: "NormalizedToolingFlag",
  description: "Canonical normalized tooling flag metadata.",
});
export type NormalizedToolingFlag = typeof NormalizedToolingFlag.Type;

const normalizedArgFields = {
  name: Schema.String.annotate({ description: "Canonical declared argument name." }),
  order: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ).annotate({
    description: "Normalized positional order.",
  }),
  required: Schema.Boolean.annotate({ description: "Whether omission is refused." }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "Presentation-only help text." }),
};
export const NormalizedToolingArg = Schema.Union([
  Schema.Struct({ ...normalizedArgFields, ...sensitiveInputFields }),
  Schema.Struct({ ...normalizedArgFields, ...stringInputFields }),
]).annotate({
  identifier: "NormalizedToolingArg",
  description: "Canonical normalized tooling positional metadata.",
});
export type NormalizedToolingArg = typeof NormalizedToolingArg.Type;

export const ToolingInputRevision = Schema.String.pipe(Schema.brand("ToolingInputRevision"));
export type ToolingInputRevision = typeof ToolingInputRevision.Type;
export const ToolingInputDeclaration = Schema.Struct({
  flags: Schema.Array(NormalizedToolingFlag).annotate({
    description: "Flags in canonical declaration order.",
  }),
  args: Schema.Array(NormalizedToolingArg).annotate({
    description: "Positionals in canonical parsing order.",
  }),
  acceptsArguments: Schema.Boolean.annotate({
    description: "Whether supplied positional arguments or undeclared raw tails are admitted.",
  }),
  revision: ToolingInputRevision.annotate({
    description: "Digest of ordered parsing semantics, excluding presentation and executable bytes.",
  }),
}).annotate({
  identifier: "ToolingInputDeclaration",
  description: "Ordered tooling input semantics and their presentation-independent revision.",
});
export type ToolingInputDeclaration = typeof ToolingInputDeclaration.Type;

export const ToolingInvocationInput = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("RawArgv").annotate({ description: "Original argv admission mode." }),
    argv: Schema.Array(Schema.String).annotate({
      description: "Original caller tokens, without normalization.",
    }),
  }),
  Schema.Struct({
    _tag: Schema.Literal("NamedMaps").annotate({ description: "Named-map admission mode." }),
    flags: Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Supplied own-property flags awaiting authoritative binding.",
    }),
    args: Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Supplied own-property positionals awaiting authoritative binding.",
    }),
    passthroughArgv: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: "Opaque raw tail admitted only for undeclared passthrough.",
    }),
  }),
]).annotate({
  identifier: "ToolingInvocationInput",
  description: "Original argv or lossless named input supplied for authoritative admission.",
});
export type ToolingInvocationInput = typeof ToolingInvocationInput.Type;

export const ToolingInputValues = Schema.Struct({
  flags: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])).annotate({
    description: "Bound flag values by declared name; absent values are omitted.",
  }),
  args: Schema.Record(Schema.String, Schema.String).annotate({
    description: "Bound positional values by declared name; absent values are omitted.",
  }),
}).annotate({
  identifier: "ToolingInputValues",
  description: "Data-only authoritative tooling values; the LANDO_INPUT script contract.",
});
export type ToolingInputValues = typeof ToolingInputValues.Type;
