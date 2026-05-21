import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";
import type { RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";
import { RecipeManifestService } from "@lando/sdk/services";

import { NODE_POSTGRES_RECIPE_ID } from "../../recipes/builtin/node-postgres/manifest.ts";
import { lookupRecipeRenderer } from "../../recipes/builtin/registry.ts";
import { getRecipeCatalog } from "../../recipes/catalog.ts";
import { RecipeManifestServiceLive } from "../../recipes/manifest/service.ts";
import { type PostInitIO, type PostInitOutcome, runPostInit } from "../../recipes/post-init/runtime.ts";
import {
  type PromptAnswers,
  type PromptIO,
  collectPrompts,
  createStdioPromptIO,
} from "../../recipes/prompts/index.ts";
import { resolveRecipeRef } from "../../recipes/source.ts";
import {
  type ProgressEmitter,
  publishTaskCompleteAsync,
  publishTaskFailAsync,
  publishTaskStartAsync,
  publishTreeCompleteAsync,
  publishTreeStartAsync,
} from "../progress.ts";
import type { BunSelfSpawner } from "./bun-self-runner.ts";

const APP_NAME_PROMPT = "name";
const RECIPE_SELECT_PROMPT = "__recipe__";

const buildRecipeSelectPrompt = (): RecipePrompt => {
  const catalog = getRecipeCatalog();
  const choices: ReadonlyArray<RecipePromptChoice> = catalog.map((entry) => ({
    value: entry.id,
    label: entry.description === "" ? entry.title : `${entry.title} — ${entry.description}`,
  }));
  return {
    name: RECIPE_SELECT_PROMPT,
    type: "select",
    message: "Pick a recipe",
    default: NODE_POSTGRES_RECIPE_ID,
    choices,
  };
};

const resolveRecipeSelection = async (
  options: InitAppOptions,
  io: PromptIO | undefined,
  cwd: string,
): Promise<string> => {
  if (options.recipe !== undefined && options.recipe !== "") return options.recipe;
  const interactive = options.nonInteractive !== true && io !== undefined && options.yes !== true;
  if (!interactive) return NODE_POSTGRES_RECIPE_ID;
  const collected = await collectPrompts({
    prompts: [buildRecipeSelectPrompt()],
    answers: {},
    yes: false,
    nonInteractive: false,
    cwd,
    io: io as PromptIO,
  });
  const picked = collected[RECIPE_SELECT_PROMPT];
  return typeof picked === "string" ? picked : NODE_POSTGRES_RECIPE_ID;
};

export interface InitAppOptions {
  readonly cwd: string;
  readonly full?: boolean;
  readonly recipe?: string;
  readonly name?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly io?: PromptIO;
  readonly postInitSpawner?: BunSelfSpawner;
  readonly postInitIO?: PostInitIO;
  readonly events?: ProgressEmitter;
}

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
  readonly answers: PromptAnswers;
  readonly postInit: PostInitOutcome;
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
  const io = resolveIO(options);
  const recipeRef = await resolveRecipeSelection(options, io, cwd);
  const { resolved, manifest } = await loadRecipe(recipeRef, cwd);

  const renderer = resolved.root === undefined ? lookupRecipeRenderer(manifest.id) : undefined;
  if (renderer === undefined) {
    throw new Error(
      `Recipe file rendering for "${recipeRef}" is not implemented yet; only bundled built-in recipes are supported in Alpha.`,
    );
  }

  const prompts = manifest.prompts ?? [];

  const presetAnswers = composeAnswers(options);
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

  if (options.full === true && io !== undefined && io.isTTY && options.yes !== true) {
    const gate = await collectPrompts({
      prompts: [
        {
          name: "_confirm",
          type: "confirm" as const,
          message: `Ready to initialize "${appName}". Proceed?`,
          default: true,
        },
      ],
      answers: {},
      yes: false,
      nonInteractive: false,
      cwd,
      io,
    });
    if (gate._confirm !== true) {
      throw new Error(`Initialization of "${appName}" cancelled.`);
    }
  }

  const events = options.events;
  const postInitActions = manifest.postInit ?? [];
  const initParentId = `init:${manifest.id}`;
  const treeStartedAt = performance.now();
  const childIds: string[] = ["render"];
  if (postInitActions.length > 0) childIds.push("postinit");

  await publishTreeStartAsync(events, {
    parentId: initParentId,
    label: `Initialize ${appName}`,
    children: childIds,
    mode: "list",
  });

  const renderStartedAt = performance.now();
  await publishTaskStartAsync(events, {
    taskId: "render",
    parentId: initParentId,
    label: `Render recipe files (${files.length})`,
  });

  const directory = join(cwd, appName);

  try {
    const existing = await readdir(directory).catch((cause: unknown) => {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
        return undefined;
      throw cause;
    });

    if (existing !== undefined && existing.length > 0) {
      await publishTaskFailAsync(events, {
        taskId: "render",
        summary: `Init target already exists: ${directory}`,
        durationMs: Math.round(performance.now() - renderStartedAt),
      });
      await publishTreeCompleteAsync(events, {
        parentId: initParentId,
        summary: "Initialization aborted",
        succeeded: 0,
        failed: 1,
        durationMs: Math.round(performance.now() - treeStartedAt),
      });
      throw new InitTargetExistsError({
        message: `Init target already exists and is not empty: ${directory}`,
        path: directory,
        remediation: "Choose an empty directory or wait for Alpha --force support.",
      });
    }

    const rendered = renderer.render({ appName, answers: collected });

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
  } catch (cause) {
    if (cause instanceof InitTargetExistsError) throw cause;

    await publishTaskFailAsync(events, {
      taskId: "render",
      summary: "Render failed",
      durationMs: Math.round(performance.now() - renderStartedAt),
    });
    await publishTreeCompleteAsync(events, {
      parentId: initParentId,
      summary: "Initialization failed",
      succeeded: 0,
      failed: 1,
      durationMs: Math.round(performance.now() - treeStartedAt),
    });
    throw cause;
  }

  await publishTaskCompleteAsync(events, {
    taskId: "render",
    summary: `Rendered ${files.length} files`,
    durationMs: Math.round(performance.now() - renderStartedAt),
  });

  let postInit: PostInitOutcome = { executed: [] };
  if (postInitActions.length > 0) {
    const postInitStartedAt = performance.now();
    await publishTaskStartAsync(events, {
      taskId: "postinit",
      parentId: initParentId,
      label: `Run post-init actions (${postInitActions.length})`,
    });

    try {
      postInit = await runPostInit({
        actions: postInitActions,
        destination: directory,
        recipeId: manifest.id,
        appName,
        answers: collected,
        ...(options.postInitIO === undefined ? {} : { io: options.postInitIO }),
        ...(options.postInitSpawner === undefined ? {} : { spawner: options.postInitSpawner }),
      });
    } catch (cause) {
      await publishTaskFailAsync(events, {
        taskId: "postinit",
        summary: "Post-init failed",
        durationMs: Math.round(performance.now() - postInitStartedAt),
      });
      await publishTreeCompleteAsync(events, {
        parentId: initParentId,
        summary: "Initialization failed",
        succeeded: 1,
        failed: 1,
        durationMs: Math.round(performance.now() - treeStartedAt),
      });
      throw cause;
    }

    await publishTaskCompleteAsync(events, {
      taskId: "postinit",
      summary: `Ran ${postInit.executed.length} actions`,
      durationMs: Math.round(performance.now() - postInitStartedAt),
    });
  }

  await publishTreeCompleteAsync(events, {
    parentId: initParentId,
    summary: `Initialized ${appName}`,
    succeeded: childIds.length,
    failed: 0,
    durationMs: Math.round(performance.now() - treeStartedAt),
  });

  return { appName, directory, answers: collected, postInit };
};
