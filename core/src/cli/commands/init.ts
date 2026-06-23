import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";
import type {
  FileFormat,
  ManagedFile,
  PortablePath,
  PromptBatchOptions,
  RecipePrompt,
  RecipePromptChoice,
} from "@lando/sdk/schema";
import { RecipeManifestService } from "@lando/sdk/services";

import { resolveUserDataRoot } from "../../config/roots.ts";
import { type InteractionPrompter, makePromiseInteractionPrompter } from "../../interaction/prompter.ts";
import { makeInteractionService } from "../../interaction/service.ts";
import { makeDiskBackend, makeManagedFileService } from "../../managed-file/service.ts";
import { NODE_POSTGRES_RECIPE_ID } from "../../recipes/builtin/node-postgres/manifest.ts";
import { lookupRecipeRenderer } from "../../recipes/builtin/registry.ts";
import { getRecipeCatalog } from "../../recipes/catalog.ts";
import { type GitRecipeCloner, resolveGitRecipeSource } from "../../recipes/git-source.ts";
import { RecipeManifestServiceLive } from "../../recipes/manifest/service.ts";
import { type NpmRegistryClient, resolveNpmRecipeSource } from "../../recipes/npm-source.ts";
import { type PostInitIO, type PostInitOutcome, runPostInit } from "../../recipes/post-init/runtime.ts";
import type { ChoicesCommandRunner, PromptAnswers } from "../../recipes/prompts/index.ts";
import { type RecipeRegistryClient, resolveRegistryRecipeSource } from "../../recipes/registry-source.ts";
import { type ResolvedRecipe, resolveRecipeRef } from "../../recipes/source.ts";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  resolveTarballRecipeSource,
} from "../../recipes/tarball-source.ts";
import {
  type ProgressEmitter,
  publishTaskCompleteAsync,
  publishTaskFailAsync,
  publishTaskStartAsync,
  publishTreeCompleteAsync,
  publishTreeStartAsync,
} from "../progress.ts";
import { readAnswersFile } from "../prompts/answer-flags.ts";
import type { BunSelfSpawner } from "./bun-self-runner.ts";
import { parseInitSourceFlags } from "./init-source.ts";

const APP_NAME_PROMPT = "name";
const RECIPE_SELECT_PROMPT = "__recipe__";

// Code files map to js/ts so their ownership marker is a valid `//` line, not a
// `#` that would corrupt the scaffolded source.
export const inferRecipeScaffoldFormat = (dest: string): FileFormat => {
  if (dest.endsWith(".lando.yml") || dest.endsWith(".lando.yaml")) return "landofile";
  if (dest.endsWith(".yml") || dest.endsWith(".yaml")) return "yaml";
  if (dest.endsWith(".json")) return "json";
  if (dest.endsWith(".js") || dest.endsWith(".cjs") || dest.endsWith(".mjs")) return "javascript";
  if (dest.endsWith(".ts") || dest.endsWith(".cts") || dest.endsWith(".mts")) return "typescript";
  if (dest.endsWith(".env")) return "env";
  return "text";
};

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
  interaction: InteractionPrompter | undefined,
  cwd: string,
): Promise<string> => {
  if (options.recipe !== undefined && options.recipe !== "") return options.recipe;
  const interactive = options.nonInteractive !== true && interaction !== undefined && options.yes !== true;
  if (!interactive) return NODE_POSTGRES_RECIPE_ID;
  const collected = await (interaction as InteractionPrompter).promptAll([buildRecipeSelectPrompt()], {
    cwd,
    mode: "interactive",
  });
  const picked = collected[RECIPE_SELECT_PROMPT];
  return typeof picked === "string" ? picked : NODE_POSTGRES_RECIPE_ID;
};

export interface InitAppOptions {
  readonly cwd: string;
  readonly full: boolean;
  readonly recipe?: string;
  readonly source?: "git" | "tarball" | "npm" | "registry";
  readonly url?: string;
  readonly package?: string;
  readonly id?: string;
  readonly path?: string;
  readonly checksum?: string;
  readonly registryUrl?: string;
  readonly userDataRoot?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
  readonly tarballRecipeFetcher?: TarballRecipeFetcher;
  readonly tarballRecipeExtractor?: TarballRecipeExtractor;
  readonly npmRegistryClient?: NpmRegistryClient;
  readonly registryClient?: RecipeRegistryClient;
  readonly name?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly answersFile?: string;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly interaction?: InteractionPrompter;
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly postInitCommandRunner?: ChoicesCommandRunner;
  readonly postInitSpawner?: BunSelfSpawner;
  readonly postInitIO?: PostInitIO;
  readonly onWarn?: (message: string) => void;
  readonly events?: ProgressEmitter;
  // Absolute render target; defaults to `<cwd>/<appName>` when omitted.
  readonly destination?: string;
  // Run recipe `postInit:` actions after rendering; defaults to true.
  readonly runPostInit?: boolean;
}

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
  readonly answers: PromptAnswers;
  readonly postInit: PostInitOutcome;
}

const parseResolvedRecipe = async (resolved: ResolvedRecipe) => {
  if (resolved.manifest !== undefined) return { resolved, manifest: resolved.manifest };
  const exit = await Effect.runPromiseExit(
    Effect.map(
      Effect.flatMap(RecipeManifestService, (svc) => svc.parse(resolved.source, resolved.manifestYaml)),
      (manifest) => ({ resolved, manifest }),
    ).pipe(Effect.provide(RecipeManifestServiceLive)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
};

const loadRecipe = async (recipeRef: string, cwd: string) => {
  const exit = await Effect.runPromiseExit(resolveRecipeRef(recipeRef, { cwd }));
  if (Exit.isSuccess(exit)) return parseResolvedRecipe(exit.value);
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
};

const loadGitRecipe = async (options: InitAppOptions) => {
  const sourceOptions = parseInitSourceFlags({
    source: options.source,
    url: options.url,
    path: options.path,
  });
  const resolved = await resolveGitRecipeSource({
    url: sourceOptions.url ?? "",
    ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
    ...(options.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: options.gitRecipeCloner }),
  });
  return parseResolvedRecipe(resolved);
};

const loadTarballRecipe = async (options: InitAppOptions, interaction: InteractionPrompter | undefined) => {
  const sourceOptions = parseInitSourceFlags({
    source: options.source,
    url: options.url,
    path: options.path,
    checksum: options.checksum,
  });
  const interactive = options.nonInteractive !== true && options.yes !== true && interaction !== undefined;
  const confirmUnverified = interactive
    ? async (sha256: string): Promise<boolean> =>
        (interaction as InteractionPrompter).confirm({
          message: `No --checksum supplied for this tarball recipe; downloaded SHA-256 is ${sha256}. Continue without checksum verification?`,
          name: "checksum",
          default: false,
          mode: "interactive",
        })
    : undefined;
  const onWarn = confirmUnverified === undefined ? (options.onWarn ?? options.postInitIO?.err) : undefined;
  const resolved = await resolveTarballRecipeSource({
    url: sourceOptions.url ?? "",
    ...(sourceOptions.checksum === undefined ? {} : { checksum: sourceOptions.checksum }),
    ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
    ...(options.tarballRecipeFetcher === undefined ? {} : { fetcher: options.tarballRecipeFetcher }),
    ...(options.tarballRecipeExtractor === undefined ? {} : { extractor: options.tarballRecipeExtractor }),
    ...(onWarn === undefined ? {} : { onWarn }),
    ...(confirmUnverified === undefined ? {} : { confirmUnverified }),
  });
  return parseResolvedRecipe(resolved);
};

const loadNpmRecipe = async (options: InitAppOptions) => {
  const sourceOptions = parseInitSourceFlags({
    source: options.source,
    package: options.package,
    path: options.path,
  });
  const resolved = await resolveNpmRecipeSource({
    package: sourceOptions.package ?? "",
    ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
    ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
    ...(options.npmRegistryClient === undefined ? {} : { registryClient: options.npmRegistryClient }),
    ...(options.tarballRecipeFetcher === undefined ? {} : { fetcher: options.tarballRecipeFetcher }),
    ...(options.tarballRecipeExtractor === undefined ? {} : { extractor: options.tarballRecipeExtractor }),
  });
  return parseResolvedRecipe(resolved);
};

const loadRegistryRecipe = async (options: InitAppOptions) => {
  const sourceOptions = parseInitSourceFlags({
    source: options.source,
    id: options.id,
    path: options.path,
  });
  const resolved = await resolveRegistryRecipeSource({
    id: sourceOptions.id ?? "",
    ...(sourceOptions.path === undefined ? {} : { path: sourceOptions.path }),
    ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
    ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
    ...(options.registryClient === undefined ? {} : { registryClient: options.registryClient }),
    ...(options.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: options.gitRecipeCloner }),
    ...(options.tarballRecipeFetcher === undefined
      ? {}
      : { tarballRecipeFetcher: options.tarballRecipeFetcher }),
    ...(options.tarballRecipeExtractor === undefined
      ? {}
      : { tarballRecipeExtractor: options.tarballRecipeExtractor }),
  });
  return parseResolvedRecipe(resolved);
};

const composeAnswers = async (options: InitAppOptions): Promise<Record<string, string>> => {
  const fileAnswers =
    options.answersFile === undefined ? {} : await readAnswersFile(resolve(options.cwd, options.answersFile));
  const out: Record<string, string> = { ...fileAnswers, ...(options.answers ?? {}) };
  if (options.name !== undefined && options.name.trim() !== "") {
    out[APP_NAME_PROMPT] = options.name.trim();
  }
  return out;
};

// Standalone callers still route through the single InteractionService chokepoint.
const defaultInitPrompter = (choicesRunner?: ChoicesCommandRunner): InteractionPrompter =>
  makePromiseInteractionPrompter(
    makeInteractionService(choicesRunner === undefined ? {} : { choicesRunner }),
  );

type InternalPromptBatchOptions = PromptBatchOptions & {
  readonly choicesRunner?: ChoicesCommandRunner;
};

export const initApp = async (options: InitAppOptions): Promise<InitAppResult> => {
  const { cwd } = options;
  const prompter = options.interaction ?? defaultInitPrompter(options.choicesRunner);
  const interactivePrompter = options.nonInteractive === true ? undefined : prompter;
  const sourceOptions = parseInitSourceFlags({
    source: options.source,
    url: options.url,
    package: options.package,
    id: options.id,
    path: options.path,
  });
  const remoteRef = sourceOptions.url ?? sourceOptions.package ?? sourceOptions.id;
  const recipeRef =
    sourceOptions.source !== undefined && remoteRef !== undefined
      ? remoteRef
      : await resolveRecipeSelection(options, interactivePrompter, cwd);
  const { resolved, manifest } =
    sourceOptions.source === "git"
      ? await loadGitRecipe(options)
      : sourceOptions.source === "tarball"
        ? await loadTarballRecipe(options, interactivePrompter)
        : sourceOptions.source === "npm"
          ? await loadNpmRecipe(options)
          : sourceOptions.source === "registry"
            ? await loadRegistryRecipe(options)
            : await loadRecipe(recipeRef, cwd);

  const renderer = resolved.root === undefined ? lookupRecipeRenderer(manifest.id) : undefined;
  if (renderer === undefined) {
    throw new Error(
      `Recipe file rendering for "${recipeRef}" is not implemented yet; only bundled built-in recipes are supported in Alpha.`,
    );
  }

  const prompts = manifest.prompts ?? [];

  const presetAnswers = await composeAnswers(options);

  const collected = await prompter.promptAll(prompts, {
    answers: presetAnswers,
    cwd,
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    interactive: options.nonInteractive !== true,
    ...(manifest.runs === undefined ? {} : { runs: manifest.runs }),
    ...(options.choicesRunner === undefined ? {} : { choicesRunner: options.choicesRunner }),
  } satisfies InternalPromptBatchOptions);

  const appNameValue = collected[APP_NAME_PROMPT];
  if (typeof appNameValue !== "string" || appNameValue === "") {
    throw new Error(`Recipe "${recipeRef}" requires a text answer for prompt 'name'.`);
  }
  const appName = appNameValue;

  const files = manifest.files ?? [];
  if (files.length === 0) {
    throw new Error(`Recipe "${recipeRef}" is missing a files: manifest.`);
  }

  const events = options.events;
  const postInitActions = manifest.postInit ?? [];
  const shouldRunPostInit = options.runPostInit !== false && postInitActions.length > 0;
  const initParentId = `init:${manifest.id}`;
  const treeStartedAt = performance.now();
  const childIds: string[] = ["render"];
  if (shouldRunPostInit) childIds.push("postinit");

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

  const directory = options.destination ?? join(cwd, appName);

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

    const managedFiles = files.map((file): ManagedFile => {
      const content = rendered.get(file.dest);
      if (content === undefined) {
        throw new Error(
          `Recipe "${recipeRef}" lists file dest "${file.dest}" in its manifest but its renderer did not produce content for it.`,
        );
      }
      return {
        id: `${manifest.id}:${file.dest}`,
        owner: manifest.id,
        path: file.dest as PortablePath,
        mode: "file",
        format: inferRecipeScaffoldFormat(file.dest),
        content: { kind: "text", value: content },
        onConflict: "fail",
      };
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* makeDiskBackend({
            defaultBase: () => directory,
            ledgerRoot: () => options.userDataRoot ?? resolveUserDataRoot(),
          });
          const service = yield* makeManagedFileService(backend);
          yield* service.apply(managedFiles);
        }),
      ),
    );
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
  if (shouldRunPostInit) {
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
        ...(options.postInitCommandRunner === undefined
          ? {}
          : { commandRunner: options.postInitCommandRunner }),
        ...(manifest.runs === undefined ? {} : { runs: manifest.runs }),
        ...(resolved.root === undefined ? {} : { recipeRoot: resolved.root }),
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
