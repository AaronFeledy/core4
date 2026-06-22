import { Schema } from "effect";

// Generalized prompt vocabulary published for the InteractionService contract.
// Recipe prompts (`sdk/src/schema/recipe.ts`) reuse these schemas plus the
// recipe-only `when:`/`deprecated:` fields, so the recipe prompt serialized
// shape is unchanged apart from the additive `editor` prompt type.

/** Prompt control type — the eight published prompt types. */
export const PromptType = Schema.Literal(
  "text",
  "select",
  "multiselect",
  "confirm",
  "number",
  "secret",
  "path",
  "editor",
);
export type PromptType = typeof PromptType.Type;

/** Dynamic-choices source — run a canonical Lando command and parse its stdout into choices. */
export const ChoicesFrom = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  parse: Schema.Literal("json", "lines"),
});
export type ChoicesFrom = typeof ChoicesFrom.Type;

/** Prompt choice — bare value or labeled object. */
export const PromptChoice = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Struct({
    value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
);
export type PromptChoice = typeof PromptChoice.Type;

/** Prompt validation — per-type validator keys. */
export const PromptValidate = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  exists: Schema.optional(Schema.Boolean),
});
export type PromptValidate = typeof PromptValidate.Type;

/** Resolved prompt answer — a scalar or a list of scalars (for `multiselect`). */
export const PromptAnswer = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.Union(Schema.String, Schema.Number, Schema.Boolean)),
);
export type PromptAnswer = typeof PromptAnswer.Type;

/** Generalized prompt specification — the published prompting vocabulary. */
export const PromptSpec = Schema.Struct({
  name: Schema.String,
  type: PromptType,
  message: Schema.String,
  default: Schema.optional(Schema.Union(Schema.String, Schema.Number, Schema.Boolean)),
  validate: Schema.optional(PromptValidate),
  choices: Schema.optional(Schema.Array(PromptChoice)),
  choicesFrom: Schema.optional(ChoicesFrom),
});
export type PromptSpec = typeof PromptSpec.Type;

/** Interactivity mode for a prompt batch. `auto` gates interactivity on a TTY stdin. */
export type PromptMode = "auto" | "interactive" | "non-interactive";

/**
 * Answer-source and interactivity options threaded into a prompt batch.
 *
 * Type-only: the default `InteractionServiceLive` implementation resolves the answer
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
  /** Interactivity mode; `auto` keys off TTY stdin. */
  readonly mode?: PromptMode;
  /** Working directory used for `path`-type resolution. */
  readonly cwd?: string;
}
