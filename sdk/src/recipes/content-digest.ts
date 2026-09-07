import { createHash } from "node:crypto";
import { Schema } from "effect";
import { RecipeContentDigest } from "../schema/recipe-identity.ts";
import type { RecipeManifest, RecipePrompt } from "../schema/recipe.ts";
import { canonicalJson } from "./migration-chain.ts";

/**
 * Declarative recipe inputs that form versioned identity. The digest field and
 * migration history are omitted so a producer can record its own digest without
 * a circular definition. Prompt defaults and other runtime answers never appear.
 */
export type RecipeContentDigestProjection = {
  readonly id: string;
  readonly version: string;
  readonly extends?: string;
  readonly optionTypes: unknown;
  readonly defaults: unknown;
  readonly template: unknown;
  readonly assets: unknown;
  readonly files: unknown;
  readonly postInit: unknown;
  readonly prompts: unknown;
};

const projectPrompt = (prompt: RecipePrompt) => ({
  name: prompt.name,
  type: prompt.type,
  when: prompt.when,
  disposition: prompt.disposition,
  choices: prompt.choices,
});

/**
 * Project the §3 digest inputs from a manifest. Migrations, snapshot identity,
 * and prompt defaults are dropped so the hash cannot observe history or answers.
 */
export const recipeContentDigestProjection = (manifest: RecipeManifest): RecipeContentDigestProjection => ({
  id: manifest.id,
  version: manifest.version,
  ...(manifest.extends === undefined ? {} : { extends: manifest.extends }),
  optionTypes: manifest.snapshot?.optionTypes ?? {},
  defaults: manifest.snapshot?.defaults ?? {},
  template: manifest.snapshot?.template,
  assets: manifest.snapshot?.assets ?? [],
  files: (manifest.files ?? []).map((file) => ({
    src: file.src,
    dest: file.dest,
    ...(file.mode === undefined ? {} : { mode: file.mode }),
    ...(file.template === undefined ? {} : { template: file.template }),
    ...(file.engine === undefined ? {} : { engine: file.engine }),
    ...(file.when === undefined ? {} : { when: file.when }),
  })),
  postInit: manifest.postInit ?? [],
  prompts: (manifest.prompts ?? []).map(projectPrompt),
});

/**
 * SHA-256 over canonical JSON of the digest projection. Extra keys on `content`
 * are hashed; callers must pass {@link recipeContentDigestProjection} or an
 * equivalent already-stripped object.
 */
export const computeRecipeContentDigest = (content: RecipeContentDigestProjection): RecipeContentDigest =>
  Schema.decodeUnknownSync(RecipeContentDigest)(
    `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`,
  );
