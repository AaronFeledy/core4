import { mkdir } from "node:fs/promises";
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
import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";

import { resolveUserDataRoot } from "@lando/engine/config/roots";
import { makeDiskBackend, makeManagedFileService } from "@lando/managed-file/service";
import { type InteractionPrompter, makePromiseInteractionPrompter } from "../../interaction/prompter";
import { makeDefaultResolveInteractionDriver, makeInteractionService } from "../../interaction/service";
import { getInteractionServiceOverride } from "../../interaction/testing-override";
import { NODE_POSTGRES_RECIPE_ID } from "../../recipes/builtin/node-postgres/manifest";
import { lookupRecipeRenderer } from "../../recipes/builtin/registry";
import { getRecipeCatalog } from "../../recipes/catalog";
import { type GitRecipeCloner, resolveGitRecipeSource } from "../../recipes/git-source";
import { RecipeManifestServiceLive } from "../../recipes/manifest/service";
import { type NpmRegistryClient, resolveNpmRecipeSource } from "../../recipes/npm-source";
import { type PostInitIO, type PostInitOutcome, runPostInit } from "../../recipes/post-init/runtime";
import type { ChoicesCommandRunner, PromptAnswers } from "../../recipes/prompts/index";
import { type RecipeRegistryClient, resolveRegistryRecipeSource } from "../../recipes/registry-source";
import { type ResolvedRecipe, resolveRecipeRef } from "../../recipes/source";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  resolveTarballRecipeSource,
} from "../../recipes/tarball-source";
import { readAnswersFile } from "../prompts/answer-flags";
import { activeRendererMode } from "../renderer-mode-state";
import type { BunSelfSpawner } from "./bun-self-runner";
import { defaultAppNameFromCwd, withAppNameDefault } from "./init-app-name";
import { chromeForInitNamePrompt } from "./init-app-name-chrome";
import { resolveInitDestination } from "./init-destination";
import { parseInitSourceFlags } from "./init-source";
import { planInitWrites } from "./init-write-plan";

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

const sortedRecipeCatalog = () =>
  [...getRecipeCatalog()].sort((left, right) =>
    left.title.localeCompare(right.title, "en", { sensitivity: "base" }),
  );

const buildRecipeSelectPrompt = (): RecipePrompt => {
  const choices: ReadonlyArray<RecipePromptChoice> = sortedRecipeCatalog().map((entry) => ({
    value: entry.id,
    label: entry.title,
    ...(entry.description.trim() !== "" ? { description: entry.description } : {}),
  }));
  return {
    name: RECIPE_SELECT_PROMPT,
    type: "select",
    message: "Pick a recipe",
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
  return typeof picked === "string" ? picked : (sortedRecipeCatalog()[0]?.id ?? NODE_POSTGRES_RECIPE_ID);
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
  readonly skippedScaffold: ReadonlyArray<string>;
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
    getInteractionServiceOverride() ??
      makeInteractionService({
        resolveDriver:
          activeRendererMode === "lando" ? makeDefaultResolveInteractionDriver() : async () => undefined,
        ...(choicesRunner === undefined ? {} : { choicesRunner }),
      }),
  );

type InternalPromptBatchOptions = PromptBatchOptions & {
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly chrome?: ReturnType<typeof chromeForInitNamePrompt>;
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

  const prompts = withAppNameDefault(manifest.prompts ?? [], options.destination ?? cwd);

  const presetAnswers = await composeAnswers(options);
  const previewAppName =
    typeof presetAnswers[APP_NAME_PROMPT] === "string" && presetAnswers[APP_NAME_PROMPT] !== ""
      ? presetAnswers[APP_NAME_PROMPT]
      : defaultAppNameFromCwd(options.destination ?? cwd);
  const previewYaml =
    renderer.render({ appName: previewAppName, answers: presetAnswers }).get(".lando.yml") ?? "";

  const collected = await prompter.promptAll(prompts, {
    answers: presetAnswers,
    cwd,
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    interactive: options.nonInteractive !== true,
    ...(manifest.runs === undefined ? {} : { runs: manifest.runs }),
    ...(options.choicesRunner === undefined ? {} : { choicesRunner: options.choicesRunner }),
    ...{
      chrome: chromeForInitNamePrompt({
        appRoot: options.destination ?? cwd,
        landofileYaml: previewYaml,
      }),
    },
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

  const directory = resolveInitDestination({
    cwd,
    ...(options.destination === undefined ? {} : { destination: options.destination }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const existing = new Set<string>();
  await Promise.all(
    files.map(async (file) => {
      if (await Bun.file(join(directory, file.dest)).exists()) existing.add(file.dest);
    }),
  );
  const writePlan = planInitWrites(
    files.map((file) => file.dest),
    existing,
  );
  const writeDests = new Set(writePlan.write);
  const filesToWrite = files.filter((file) => writeDests.has(file.dest));
  const postInitActions = (manifest.postInit ?? []).filter(
    (action) => writePlan.skippedScaffold.length === 0 || action.type === "message",
  );

  const shouldRunPostInit = options.runPostInit !== false && postInitActions.length > 0;
  const initParentId = `init:${manifest.id}`;
  const tree = makeTaskTree(options.events, {
    parentId: initParentId,
    label: `Initialize ${appName}`,
    children: [
      { id: "render", label: `Render recipe files (${filesToWrite.length})` },
      ...(shouldRunPostInit
        ? [{ id: "postinit", label: `Run post-init actions (${postInitActions.length})` }]
        : []),
    ],
    mode: "list",
  });

  await Effect.runPromise(tree.start);
  await Effect.runPromise(tree.startTask("render"));

  try {
    if (writePlan.landofileConflict !== undefined) {
      const conflictPath = join(directory, writePlan.landofileConflict);
      await Effect.runPromise(
        tree.failTask("render", `Init target already has a Landofile: ${conflictPath}`),
      );
      await Effect.runPromise(tree.close("Initialization aborted"));
      throw new InitTargetExistsError({
        message: `Init target already has a Landofile: ${conflictPath}`,
        path: conflictPath,
        remediation: "Remove the existing Landofile or choose a different directory.",
      });
    }

    const rendered = renderer.render({ appName, answers: collected });

    await mkdir(directory, { recursive: true });

    const managedFiles = filesToWrite.map((file): ManagedFile => {
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

    await Effect.runPromise(tree.failTask("render", "Render failed"));
    await Effect.runPromise(tree.close("Initialization failed"));
    throw cause;
  }

  await Effect.runPromise(tree.completeTask("render", `Rendered ${filesToWrite.length} files`));

  let postInit: PostInitOutcome = { executed: [] };
  if (shouldRunPostInit) {
    await Effect.runPromise(tree.startTask("postinit"));

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
      await Effect.runPromise(tree.failTask("postinit", "Post-init failed"));
      await Effect.runPromise(tree.close("Initialization failed"));
      throw cause;
    }

    await Effect.runPromise(tree.completeTask("postinit", `Ran ${postInit.executed.length} actions`));
  }

  await Effect.runPromise(tree.close(`Initialized ${appName}`));

  return { appName, directory, answers: collected, postInit, skippedScaffold: writePlan.skippedScaffold };
};
