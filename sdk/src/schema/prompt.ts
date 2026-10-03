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

/** Prompt validation — per-type validator keys. */
export const PromptValidate = Schema.Struct({
  pattern: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number),
  exists: Schema.optionalKey(Schema.Boolean),
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
  default: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  validate: Schema.optionalKey(PromptValidate),
  choices: Schema.optionalKey(Schema.Array(PromptChoice)),
  choicesFrom: Schema.optionalKey(ChoicesFrom),
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
  /** Command ids allowed for dynamic `choicesFrom` prompts. */
  readonly runs?: ReadonlyArray<string>;
}
