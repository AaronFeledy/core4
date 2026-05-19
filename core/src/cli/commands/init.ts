import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import { NODE_POSTGRES_RECIPE_ID } from "../../recipes/builtin/node-postgres/manifest.ts";
import { lookupRecipeRenderer } from "../../recipes/builtin/registry.ts";
import { RecipeManifestServiceLive } from "../../recipes/manifest/service.ts";
import {
  type PromptAnswers,
  type PromptIO,
  collectPrompts,
  createStdioPromptIO,
} from "../../recipes/prompts/index.ts";
import { resolveRecipeRef } from "../../recipes/source.ts";

const APP_NAME_PROMPT = "name";

export interface InitAppOptions {
  readonly cwd: string;
  readonly full: boolean;
  readonly recipe?: string;
  readonly name?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly io?: PromptIO;
}

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
  readonly answers: PromptAnswers;
}

const loadRecipe = async (recipeRef: string, cwd: string) => {
  const exit = await Effect.runPromiseExit(
    resolveRecipeRef(recipeRef, { cwd }).pipe(
      Effect.flatMap((resolved) =>
        Effect.map(
          Effect.flatMap(RecipeManifestService, (svc) => svc.parse(resolved.source, resolved.manifestYaml)),
          (manifest) => ({ resolved, manifest }),
        ),
      ),
      Effect.provide(RecipeManifestServiceLive),
    ),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
};

const composeAnswers = (options: InitAppOptions): Record<string, string> => {
  const out: Record<string, string> = { ...(options.answers ?? {}) };
  if (options.name !== undefined && options.name.trim() !== "") {
    out[APP_NAME_PROMPT] = options.name.trim();
  }
  return out;
};

const resolveIO = (options: InitAppOptions): PromptIO | undefined => {
  if (options.nonInteractive === true) return undefined;
  if (options.io !== undefined) return options.io;
  return createStdioPromptIO();
};

export const initApp = async (options: InitAppOptions): Promise<InitAppResult> => {
  const { cwd } = options;
  const recipeRef = options.recipe ?? NODE_POSTGRES_RECIPE_ID;
  const { resolved, manifest } = await loadRecipe(recipeRef, cwd);

  const renderer = resolved.root === undefined ? lookupRecipeRenderer(manifest.id) : undefined;
  if (renderer === undefined) {
    throw new Error(
      `Recipe file rendering for "${recipeRef}" is not implemented yet; only bundled built-in recipes are supported in Alpha.`,
    );
  }

  const prompts = manifest.prompts ?? [];

  const presetAnswers = composeAnswers(options);
  const io = resolveIO(options);
  const useDefaults = options.yes === true;

  const collected = await collectPrompts({
    prompts,
    answers: presetAnswers,
    yes: useDefaults,
    nonInteractive: options.nonInteractive === true || io === undefined,
    cwd,
    ...(io === undefined ? {} : { io }),
  });

  const appNameValue = collected[APP_NAME_PROMPT];
  if (typeof appNameValue !== "string" || appNameValue === "") {
    throw new Error(`Recipe "${recipeRef}" requires a text answer for prompt 'name'.`);
  }
  const appName = appNameValue;

  const files = manifest.files ?? [];
  if (files.length === 0) {
    throw new Error(`Recipe "${recipeRef}" is missing a files: manifest.`);
  }

  const rendered = renderer.render({ appName, answers: collected });

  const directory = join(cwd, appName);
  const existing = await readdir(directory).catch((cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });

  if (existing !== undefined && existing.length > 0) {
    throw new InitTargetExistsError({
      message: `Init target already exists and is not empty: ${directory}`,
      path: directory,
      remediation: "Choose an empty directory or wait for Alpha --force support.",
    });
  }

  await mkdir(directory, { recursive: true });

  for (const file of files) {
    const content = rendered.get(file.dest);
    if (content === undefined) {
      throw new Error(
        `Recipe "${recipeRef}" lists file dest "${file.dest}" in its manifest but its renderer did not produce content for it.`,
      );
    }
    const destPath = join(directory, file.dest);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, content);
  }

  return { appName, directory, answers: collected };
};
