import { Schema } from "effect";

import { DeprecationNotice } from "./deprecation.ts";
import { ChoicesFrom, PromptChoice, PromptType, PromptValidate } from "./prompt.ts";

// Recipe manifest schema with prompt and post-init action shapes. Recipe
// prompts reuse the generalized `PromptSpec` vocabulary (`sdk/src/schema/
// prompt.ts`) plus the recipe-only `when:`/`deprecated:` fields.

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

/** Recipe-prompt type — the generalized {@link PromptType} vocabulary. */
export const RecipePromptType = PromptType;
export type RecipePromptType = PromptType;

/** Dynamic-choices source — the generalized {@link ChoicesFrom}. */
export const RecipeChoicesFrom = ChoicesFrom;
export type RecipeChoicesFrom = ChoicesFrom;

/** Recipe-prompt choice — the generalized {@link PromptChoice}. */
export const RecipePromptChoice = PromptChoice;
export type RecipePromptChoice = PromptChoice;

/** Recipe-prompt validation — the generalized {@link PromptValidate}. */
export const RecipePromptValidate = PromptValidate;
export type RecipePromptValidate = PromptValidate;

/** Recipe prompt — {@link PromptSpec} fields plus the recipe-only `when:`/`deprecated:` keys. */
export const RecipePrompt = Schema.Struct({
  name: Schema.String,
  type: PromptType,
  message: Schema.String,
  default: Schema.optional(Schema.Union(Schema.String, Schema.Number, Schema.Boolean)),
  when: Schema.optional(Schema.String),
  validate: Schema.optional(PromptValidate),
  choices: Schema.optional(Schema.Array(PromptChoice)),
  choicesFrom: Schema.optional(ChoicesFrom),
  deprecated: Schema.optional(DeprecationNotice),
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

/** `bun install` — resolve `package.json` and write `node_modules/` in `cwd:`. */
const RecipePostInitBunInstall = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("install"),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** `bun script` — run a recipe-bundled `.bun.sh` script resolved under the recipe source tree. */
const RecipePostInitBunScript = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("script"),
  script: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** `bun add` — add explicit packages across dependency categories. */
const RecipePostInitBunAdd = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("add"),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  devDependencies: Schema.optional(Schema.Array(Schema.String)),
  peerDependencies: Schema.optional(Schema.Array(Schema.String)),
  optionalDependencies: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** `bun create` — run `bun create <template> <dest>` into a path under the recipe destination. */
const RecipePostInitBunCreate = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("create"),
  template: Schema.String,
  dest: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** `bun run` — run a `package.json#scripts` entry from `cwd:`. */
const RecipePostInitBunRun = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("run"),
  script: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** `bun x` — run a one-shot package via `bun x <spec> [argv...]` (bunx-equivalent). */
const RecipePostInitBunX = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("x"),
  spec: Schema.String,
  argv: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
});

/** Recipe post-init `bun` action — one of the supported verbs. */
export const RecipePostInitBun = Schema.Union(
  RecipePostInitBunInstall,
  RecipePostInitBunScript,
  RecipePostInitBunAdd,
  RecipePostInitBunCreate,
  RecipePostInitBunRun,
  RecipePostInitBunX,
);
export type RecipePostInitBun = typeof RecipePostInitBun.Type;

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
  deprecated: Schema.optional(DeprecationNotice),
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

/** Author-facing recipe value — what a programmatic `recipe.ts` default-exports. */
export type Recipe = RecipeManifest;

/** Context passed to a `recipe.ts` factory. */
export interface RecipeContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A `recipe.ts` factory — receives a {@link RecipeContext} and returns a {@link Recipe}. */
export type RecipeFactory = (ctx: RecipeContext) => Recipe | Promise<Recipe>;

/** Identity helper pinning a `recipe.ts` default export to the {@link Recipe}/{@link RecipeFactory} shape. */
export const defineRecipe = <const T extends Recipe | RecipeFactory>(value: T): T => value;

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
