import { Schema } from "effect";

// Recipe manifest schema with prompt and post-init action shapes.
// Unsupported fields (`editor` prompt type, non-`install` `bun:` verbs)
// are intentionally absent from the schema and are rejected before
// strict decode so users see a targeted remediation instead of a
// generic excess-property error.

const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Recipe id — kebab-case identifier; matches directory basename. */
export const RecipeId = Schema.String.pipe(
  Schema.pattern(KEBAB_CASE_PATTERN, {
    message: () => "Recipe id must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
);
export type RecipeId = typeof RecipeId.Type;

/** Recipe semver string. */
export const RecipeVersion = Schema.String.pipe(
  Schema.pattern(SEMVER_PATTERN, {
    message: () => "Recipe version must be a semver string (e.g. 1.0.0).",
  }),
);
export type RecipeVersion = typeof RecipeVersion.Type;

/** Recipe-prompt type supported by this schema (`editor` is rejected before decode). */
export const RecipePromptType = Schema.Literal(
  "text",
  "select",
  "multiselect",
  "confirm",
  "number",
  "secret",
  "path",
);
export type RecipePromptType = typeof RecipePromptType.Type;

/** Dynamic-choices source — run a canonical Lando command and parse its stdout into choices. */
export const RecipeChoicesFrom = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  parse: Schema.Literal("json", "lines"),
});
export type RecipeChoicesFrom = typeof RecipeChoicesFrom.Type;

/** Recipe-prompt choice — bare value or labeled object. */
export const RecipePromptChoice = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Struct({
    value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
);
export type RecipePromptChoice = typeof RecipePromptChoice.Type;

/** Recipe-prompt validation — per-type validator keys. */
export const RecipePromptValidate = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  exists: Schema.optional(Schema.Boolean),
});
export type RecipePromptValidate = typeof RecipePromptValidate.Type;

/** Recipe prompt. */
export const RecipePrompt = Schema.Struct({
  name: Schema.String,
  type: RecipePromptType,
  message: Schema.String,
  default: Schema.optional(Schema.Union(Schema.String, Schema.Number, Schema.Boolean)),
  when: Schema.optional(Schema.String),
  validate: Schema.optional(RecipePromptValidate),
  choices: Schema.optional(Schema.Array(RecipePromptChoice)),
  choicesFrom: Schema.optional(RecipeChoicesFrom),
});
export type RecipePrompt = typeof RecipePrompt.Type;

/** Recipe file-manifest entry. */
export const RecipeFile = Schema.Struct({
  src: Schema.String,
  dest: Schema.String,
  when: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  template: Schema.optional(Schema.Boolean),
  engine: Schema.optional(Schema.String),
});
export type RecipeFile = typeof RecipeFile.Type;

/** Recipe post-init `gitInit` action. */
export const RecipePostInitGitInit = Schema.Struct({
  type: Schema.Literal("gitInit"),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `message` action. */
export const RecipePostInitMessage = Schema.Struct({
  type: Schema.Literal("message"),
  text: Schema.String,
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `command` action — canonical Lando id from the recipe allowlist. */
export const RecipePostInitCommand = Schema.Struct({
  type: Schema.Literal("command"),
  cmd: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `bun` action — supported verbs only. */
export const RecipePostInitBun = Schema.Struct({
  type: Schema.Literal("bun"),
  /** Other verbs are rejected before decode. */
  verb: Schema.Literal("install"),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init action — discriminated by `type`. */
export const RecipePostInitAction = Schema.Union(
  RecipePostInitGitInit,
  RecipePostInitMessage,
  RecipePostInitCommand,
  RecipePostInitBun,
);
export type RecipePostInitAction = typeof RecipePostInitAction.Type;

/** Recipe requires — supported pre-conditions. */
export const RecipeRequires = Schema.Struct({
  lando: Schema.optional(Schema.String),
  hostTools: Schema.optional(Schema.Array(Schema.String)),
});
export type RecipeRequires = typeof RecipeRequires.Type;

/** Recipe manifest — the parsed `recipe.yml`. */
export const RecipeManifest = Schema.Struct({
  id: RecipeId,
  title: Schema.String,
  description: Schema.String,
  version: RecipeVersion,
  authors: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  requires: Schema.optional(RecipeRequires),
  runs: Schema.optional(Schema.Array(Schema.String)),
  fetchAllowlist: Schema.optional(Schema.Array(Schema.String)),
  prompts: Schema.optional(Schema.Array(RecipePrompt)),
  files: Schema.optional(Schema.Array(RecipeFile)),
  postInit: Schema.optional(Schema.Array(RecipePostInitAction)),
});
export type RecipeManifest = typeof RecipeManifest.Type;

/** Registry resolution result — points a recipe id at an underlying git/tarball source. */
export const RecipeRegistryResolution = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("git"),
    url: Schema.String,
    path: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("tarball"),
    url: Schema.String,
    path: Schema.optional(Schema.String),
    checksum: Schema.optional(Schema.String),
  }),
);
export type RecipeRegistryResolution = typeof RecipeRegistryResolution.Type;

/** Registry response payload for a resolved recipe id. */
export const RecipeRegistryResponse = Schema.Struct({
  id: Schema.optional(RecipeId),
  resolution: RecipeRegistryResolution,
});
export type RecipeRegistryResponse = typeof RecipeRegistryResponse.Type;
