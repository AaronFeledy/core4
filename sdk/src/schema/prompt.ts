import { Schema } from "effect";

// Generalized prompt vocabulary published for the InteractionService contract.
// Recipe prompts (`sdk/src/schema/recipe.ts`) reuse these schemas plus the
// recipe-only `when:`/`deprecated:` fields, so the recipe prompt serialized
// shape is unchanged apart from the additive `editor` prompt type.

/** Prompt control type — the eight published prompt types. */
export const PromptType = Schema.Literals([
  "text",
  "select",
  "multiselect",
  "confirm",
  "number",
  "secret",
  "path",
  "editor",
]);
export type PromptType = typeof PromptType.Type;

/** Dynamic-choices source — run a canonical Lando command and parse its stdout into choices. */
export const ChoicesFrom = Schema.Struct({
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  parse: Schema.Literals(["json", "lines"]),
});
export type ChoicesFrom = typeof ChoicesFrom.Type;

/** Prompt choice — bare value or labeled object. */
export const PromptChoice = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Struct({
    value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
    label: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
  }),
]);
export type PromptChoice = typeof PromptChoice.Type;

const scalarValidationFields = {
  pattern: Schema.optionalKey(Schema.String),
  minLength: Schema.optionalKey(Schema.Number.annotate({ description: "Minimum string length." })),
  maxLength: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum string length." })),
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number),
  integer: Schema.optionalKey(Schema.Boolean.annotate({ description: "Require an integer number." })),
};

/** Prompt validation — per-type validator keys. */
export const PromptValidate = Schema.Struct({
  ...scalarValidationFields,
  optional: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Allow omission from a prompt batch when unanswered; interactive blank omits only without a default.",
    }),
  ),
  message: Schema.optionalKey(Schema.String),
  exists: Schema.optionalKey(Schema.Boolean),
  valueType: Schema.optionalKey(
    Schema.Literals(["string", "number", "boolean", "choice", "array"]).annotate({
      description:
        "Typed value semantics independent of the presentation control; omission preserves legacy coercion.",
    }),
  ),
  minItems: Schema.optionalKey(Schema.Number.annotate({ description: "Minimum array element count." })),
  maxItems: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum array element count." })),
  items: Schema.optionalKey(
    Schema.Struct({
      ...scalarValidationFields,
      valueType: Schema.Literals(["string", "number", "boolean"]).annotate({
        description: "Scalar array element type.",
      }),
    }).annotate({ description: "Element coercion and constraints for arrays without enumerated choices." }),
  ),
});
export type PromptValidate = typeof PromptValidate.Type;

/** Resolved prompt answer — a scalar or a list of scalars (for `multiselect`). */
export const PromptAnswer = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
]);
export type PromptAnswer = typeof PromptAnswer.Type;

/** Generalized prompt specification — the published prompting vocabulary. */
export const PromptSpec = Schema.Struct({
  name: Schema.String,
  type: PromptType,
  message: Schema.String,
  default: Schema.optionalKey(PromptAnswer),
  validate: Schema.optionalKey(PromptValidate),
  choices: Schema.optionalKey(Schema.Array(PromptChoice)),
  choicesFrom: Schema.optionalKey(ChoicesFrom),
});
export type PromptSpec = typeof PromptSpec.Type;

/** Interactivity mode for a prompt batch. `auto` prompts only when stdin and stderr are TTYs. */
export type PromptMode = "auto" | "interactive" | "non-interactive";

/**
 * Answer-source and interactivity options threaded into a prompt batch.
 *
 * Type-only: the default interaction-service implementation resolves the answer
 * precedence (explicit answer → default when non-interactive → interactive
 * prompt → `InteractionRequiredError`).
 */
export interface PromptBatchOptions {
  /** Explicit answers keyed by prompt name. Highest precedence. */
  readonly answers?: Readonly<Record<string, string>>;
  /** Path to an answers file merged below `answers`. */
  readonly answersFile?: string;
  /** Resolve defaults instead of prompting (the `--yes` gate). */
  readonly yes?: boolean;
  /** Force interactive (`true`) or non-interactive (`false`) resolution. */
  readonly interactive?: boolean;
  /** Interactivity mode; `auto` prompts only when stdin and stderr are TTYs. */
  readonly mode?: PromptMode;
  /** Working directory used for `path`-type resolution. */
  readonly cwd?: string;
  /** Command ids allowed for dynamic `choicesFrom` prompts. */
  readonly runs?: ReadonlyArray<string>;
}
