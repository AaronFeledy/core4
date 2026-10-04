import { Schema } from "effect";

import { DeprecationNotice } from "./deprecation.ts";
import { ChoicesFrom, PromptChoice, PromptType, PromptValidate } from "./prompt.ts";
import { RecipeId, RecipeVersion } from "./recipe-identity.ts";
import { RecipeMigration, RecipeSnapshot } from "./recipe-snapshot.ts";

export { RecipeId, RecipeVersion } from "./recipe-identity.ts";

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

/**
 * Where a secret answer is allowed to go. A prompt declares exactly one:
 * either the answer is an existing stored-secret reference recorded into the
 * named field, or it is delivered once at init time to a single named sink.
 * There is no third option, and neither form lets a raw value reach a
 * template, argv, an emitted file, provenance, or a diagnostic.
 */
export const RecipeSecretDisposition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("secret-store").annotate({
      description: "Record an existing stored-secret reference instead of a value.",
    }),
    field: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
      description: "Field that receives the approved stored-secret reference.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("init-only").annotate({
      description: "Deliver the answer once to a named init-only sink and never persist it.",
    }),
    sink: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("stdin").annotate({
          description: "Deliver on the post-init action's standard input.",
        }),
      }),
      Schema.Struct({
        kind: Schema.Literal("secretEnv").annotate({
          description: "Deliver as one named post-init secret environment variable.",
        }),
        name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
          description: "Secret environment variable name receiving the answer.",
        }),
      }),
    ]).annotate({ description: "The single init-only sink this answer may reach." }),
  }),
]);
export type RecipeSecretDisposition = typeof RecipeSecretDisposition.Type;

/** Recipe prompt — {@link PromptSpec} fields plus the recipe-only `when:`/`deprecated:` keys. */
export const RecipePrompt = Schema.Struct({
  name: Schema.String,
  type: PromptType,
  message: Schema.String,
  default: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  when: Schema.optionalKey(Schema.String),
  validate: Schema.optionalKey(PromptValidate),
  choices: Schema.optionalKey(Schema.Array(PromptChoice)),
  choicesFrom: Schema.optionalKey(ChoicesFrom),
  deprecated: Schema.optionalKey(DeprecationNotice),
  disposition: Schema.optionalKey(
    RecipeSecretDisposition.annotate({
      description: "Required on a secret prompt; forbidden elsewhere. Names the single allowed destination.",
    }),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (value.type === "secret") {
        if (value.disposition === undefined) {
          return {
            path: ["disposition"],
            issue: `Secret prompt "${value.name}" must declare exactly one disposition.`,
          };
        }
        if (value.default !== undefined) {
          return {
            path: ["default"],
            issue: `Secret prompt "${value.name}" must not declare a default value.`,
          };
        }
        return true;
      }
      if (value.disposition !== undefined) {
        return {
          path: ["disposition"],
          issue: `Prompt "${value.name}" is not a secret prompt and must not declare a disposition.`,
        };
      }
      return true;
    }),
  ),
);
export type RecipePrompt = typeof RecipePrompt.Type;

/** Binding that names which secret prompt feeds an init-only sink. Values never appear. */
const RecipeSecretSinkBinding = Schema.Struct({
  prompt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "Secret prompt whose answer the resolver delivers to this sink.",
  }),
});

const secretSinkFields = {
  stdin: Schema.optionalKey(
    RecipeSecretSinkBinding.annotate({
      description: "Secret prompt delivered on this action's standard input.",
    }),
  ),
  secretEnv: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Secret environment variable name to the prompt whose answer fills it.",
    }),
  ),
} as const;

/** Authoring-only prompt drop — consumed by flatten on raw objects before RecipeManifest decode. */
export const RecipePromptDrop = Schema.Struct({
  name: Schema.String.annotate({
    description: "Prompt name to remove from the inherited parent recipe.",
  }),
  drop: Schema.Literal(true).annotate({
    description: "When true, remove the named parent prompt instead of merging it.",
  }),
});
export type RecipePromptDrop = typeof RecipePromptDrop.Type;

/** Recipe file-manifest entry. */
export const RecipeFile = Schema.Struct({
  src: Schema.String,
  dest: Schema.String,
  when: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  template: Schema.optionalKey(Schema.Boolean),
  engine: Schema.optionalKey(Schema.String),
});
export type RecipeFile = typeof RecipeFile.Type;

/** Recipe post-init `gitInit` action. */
export const RecipePostInitGitInit = Schema.Struct({
  type: Schema.Literal("gitInit"),
  when: Schema.optionalKey(Schema.String),
});

/** Recipe post-init `message` action. */
export const RecipePostInitMessage = Schema.Struct({
  type: Schema.Literal("message"),
  text: Schema.String,
  when: Schema.optionalKey(Schema.String),
});

/** Recipe post-init `command` action — canonical Lando id from the recipe allowlist. */
export const RecipePostInitCommand = Schema.Struct({
  type: Schema.Literal("command"),
  cmd: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** `bun install` — resolve `package.json` and write `node_modules/` in `cwd:`. */
const RecipePostInitBunInstall = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("install"),
  cwd: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** `bun script` — run a recipe-bundled `.bun.sh` script resolved under the recipe source tree. */
const RecipePostInitBunScript = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("script"),
  script: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** `bun add` — add explicit packages across dependency categories. */
const RecipePostInitBunAdd = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("add"),
  dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** `bun create` — run `bun create <template> <dest>` into a path under the recipe destination. */
const RecipePostInitBunCreate = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("create"),
  template: Schema.String,
  dest: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** `bun run` — run a `package.json#scripts` entry from `cwd:`. */
const RecipePostInitBunRun = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("run"),
  script: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** `bun x` — run a one-shot package via `bun x <spec> [argv...]` (bunx-equivalent). */
const RecipePostInitBunX = Schema.Struct({
  type: Schema.Literal("bun"),
  verb: Schema.Literal("x"),
  spec: Schema.String,
  argv: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Schema.String),
  ...secretSinkFields,
});

/** Recipe post-init `bun` action — one of the supported verbs. */
export const RecipePostInitBun = Schema.Union([
  RecipePostInitBunInstall,
  RecipePostInitBunScript,
  RecipePostInitBunAdd,
  RecipePostInitBunCreate,
  RecipePostInitBunRun,
  RecipePostInitBunX,
]);
export type RecipePostInitBun = typeof RecipePostInitBun.Type;

/** Recipe post-init action — discriminated by `type`. */
export const RecipePostInitAction = Schema.Union([
  RecipePostInitGitInit,
  RecipePostInitMessage,
  RecipePostInitCommand,
  RecipePostInitBun,
]);
export type RecipePostInitAction = typeof RecipePostInitAction.Type;

/** Recipe requires — supported pre-conditions. */
export const RecipeRequires = Schema.Struct({
  lando: Schema.optionalKey(Schema.String),
  hostTools: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type RecipeRequires = typeof RecipeRequires.Type;

/** Recipe manifest — the parsed `recipe.yml`. */
export const RecipeManifest = Schema.Struct({
  id: RecipeId,
  title: Schema.String,
  description: Schema.String,
  version: RecipeVersion,
  extends: Schema.optionalKey(
    Schema.String.annotate({
      description: "Parent recipe id or path flattened into this recipe before validation.",
    }),
  ),
  deprecated: Schema.optionalKey(DeprecationNotice),
  authors: Schema.optionalKey(Schema.Array(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  requires: Schema.optionalKey(RecipeRequires),
  runs: Schema.optionalKey(Schema.Array(Schema.String)),
  fetchAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
  prompts: Schema.optionalKey(Schema.Array(RecipePrompt)),
  files: Schema.optionalKey(Schema.Array(RecipeFile)),
  postInit: Schema.optionalKey(Schema.Array(RecipePostInitAction)),
  snapshot: Schema.optionalKey(
    RecipeSnapshot.annotate({
      description:
        "Declarative data that renders this version's authoring output without running recipe code.",
    }),
  ),
  migrations: Schema.optionalKey(
    Schema.Array(RecipeMigration).annotate({
      description: "Ordered declarative edges from earlier versioned identities to this one.",
    }),
  ),
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
export const RecipeRegistryResolution = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    url: Schema.String,
    path: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("tarball"),
    url: Schema.String,
    path: Schema.optionalKey(Schema.String),
    checksum: Schema.optionalKey(Schema.String),
  }),
]);
export type RecipeRegistryResolution = typeof RecipeRegistryResolution.Type;

/** Registry response payload for a resolved recipe id. */
export const RecipeRegistryResponse = Schema.Struct({
  id: Schema.optionalKey(RecipeId),
  resolution: RecipeRegistryResolution,
});
export type RecipeRegistryResponse = typeof RecipeRegistryResponse.Type;
