import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { LANDOFILE_NAME, LANDOFILE_TS_NAME } from "@lando/landofile/discovery";
import { InitTargetExistsError } from "@lando/sdk/errors";
import type { PromptBatchOptions, RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";
import { type ConfigTranslatorShape, RecipeManifestService } from "@lando/sdk/services";
import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

import { resolveUserDataRoot } from "@lando/engine/config/roots";
import { type InteractionPrompter, makePromiseInteractionPrompter } from "../../interaction/prompter";
import { makeDefaultResolveInteractionDriver, makeInteractionService } from "../../interaction/service";
import { getInteractionServiceOverride } from "../../interaction/testing-override";
import { lookupRecipeDecomposer } from "../../recipes/builtin/decomposers";
import { NODE_POSTGRES_RECIPE_ID } from "../../recipes/builtin/node-postgres/manifest";
import { bundledRecipeContentSource } from "../../recipes/builtin/scaffold-assets";
import { getRecipeCatalog } from "../../recipes/catalog";
import { type GitRecipeCloner, resolveGitRecipeSource } from "../../recipes/git-source";
import {
  RecipeInitCommitError,
  previewRecipeLandofile,
  runRecipeInitPipeline,
} from "../../recipes/init-pipeline";
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

const loadRecipeEncoder = async (): Promise<ConfigTranslatorShape> => {
  const { BUNDLED_PLUGIN_MODULES } = await import("../../plugins/generated/bundled.ts");
  const module = BUNDLED_PLUGIN_MODULES.find((module) => module.configTranslators?.has("lando4"));
  const loader = module?.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing bundled lando4 encoder.");
  return loader();
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
  readonly signal?: AbortSignal;
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
  readonly privateFileAccess?: PrivateFileAccess;
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
  /** Collected nonsecret answers only. Secret prompt values are never returned. */
  readonly answers: PromptAnswers;
  readonly postInit: PostInitOutcome;
  readonly skippedScaffold: ReadonlyArray<string>;
}

export const stripSecretInitAnswers = (
  prompts: ReadonlyArray<RecipePrompt>,
  answers: PromptAnswers,
): PromptAnswers => {
  const secretNames = new Set(
    prompts.filter((prompt) => prompt.type === "secret").map((prompt) => prompt.name),
  );
  return Object.fromEntries(Object.entries(answers).filter(([name]) => !secretNames.has(name)));
};

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

  const decomposer = resolved.root === undefined ? lookupRecipeDecomposer(manifest.id) : undefined;
  if (decomposer === undefined) {
    throw new Error(
      `Recipe file rendering for "${recipeRef}" is not supported; only bundled built-in recipes are supported.`,
    );
  }

  const prompts = withAppNameDefault(manifest.prompts ?? [], options.destination ?? cwd);

  const presetAnswers = await composeAnswers(options);
  const previewAppName =
    typeof presetAnswers[APP_NAME_PROMPT] === "string" && presetAnswers[APP_NAME_PROMPT] !== ""
      ? presetAnswers[APP_NAME_PROMPT]
      : defaultAppNameFromCwd(options.destination ?? cwd);
  const encoderPromise = loadRecipeEncoder();
  const previewYaml = await encoderPromise
    .then((encoder) =>
      Effect.runPromise(
        previewRecipeLandofile({
          manifest,
          decomposer,
          appName: previewAppName,
          answers: presetAnswers,
          encoder,
        }),
      ),
    )
    .then(
      ({ text }) => text,
      () => "",
    );

  const prompted = await prompter.promptAll(prompts, {
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

  // Prompt collection validates declared prompts. Preserve additional explicit
  // options for decomposers, which own their recipe-specific option contract.
  const collected = { ...presetAnswers, ...prompted };
  const publicAnswers = stripSecretInitAnswers(prompts, collected);
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
  const scaffoldDests = files
    .map((file) => file.dest)
    .filter((dest) => dest !== LANDOFILE_NAME && dest !== LANDOFILE_TS_NAME);
  const effectiveDests = [LANDOFILE_NAME, ...scaffoldDests];
  // Probe every Landofile form the loader would treat as this app, not only
  // the dest init writes. An existing .lando.ts must conflict so we never
  // drop a sibling .lando.yml beside it.
  const landofileForms = [LANDOFILE_NAME, LANDOFILE_TS_NAME] as const;
  await Promise.all(
    [...new Set([...effectiveDests, ...landofileForms])].map(async (dest) => {
      if (await Bun.file(join(directory, dest)).exists()) existing.add(dest);
    }),
  );
  const existingLandofile = landofileForms.find((dest) => existing.has(dest));
  const writePlan = planInitWrites(
    existingLandofile === undefined ? effectiveDests : [existingLandofile, ...scaffoldDests],
    existing,
  );
  const filesToWrite = writePlan.write;
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

  let postInit: PostInitOutcome = { executed: [] };
  let skippedScaffold: ReadonlyArray<string> = [];
  let postInitStarted = false;

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

    const secretNames = new Set(
      prompts.filter((prompt) => prompt.type === "secret").map((prompt) => prompt.name),
    );
    const secretAnswers: Record<string, string> = {};
    for (const name of secretNames) {
      const value = collected[name];
      if (typeof value === "string") secretAnswers[name] = value;
    }
    // The transaction resolves and locks a canonical app root, so the
    // destination must exist before it prepares anything.
    await mkdir(directory, { recursive: true });

    // The write plan is all-or-nothing for the auxiliary scaffold: one existing
    // destination withholds the whole set. The pipeline skips per destination,
    // so excluded dests must be withheld before the pipeline writes anything.
    const authorized = new Set(writePlan.write);
    const pipelineManifest = {
      ...manifest,
      files: files.filter(
        (file) =>
          file.dest === LANDOFILE_NAME || file.dest === LANDOFILE_TS_NAME || authorized.has(file.dest),
      ),
    };

    if (options.privateFileAccess === undefined) {
      throw new RecipeInitCommitError({
        message: "Private file access is unavailable for recipe initialization.",
        remediation: "Run initialization through the Lando runtime.",
        phase: "prepare",
        reason: "private-file-access-unavailable",
      });
    }
    const result = await Effect.runPromise(
      runRecipeInitPipeline({
        appRoot: directory,
        manifest: pipelineManifest,
        decomposer,
        answers: publicAnswers,
        secretAnswers,
        appName,
        encoder: await encoderPromise,
        journalRoot: () => options.userDataRoot ?? resolveUserDataRoot(),
        contentSource: bundledRecipeContentSource(manifest.id),
        privateFileAccess: options.privateFileAccess,
        ...(resolved.root === undefined ? {} : { sourceRoot: resolved.root }),
        runPostInit: async (bound) => {
          if (
            !shouldRunPostInit ||
            (writePlan.skippedScaffold.length > 0 &&
              bound.actions.some((action) => action.type !== "message"))
          ) {
            return { executed: [] };
          }
          if (!postInitStarted) {
            await Effect.runPromise(tree.completeTask("render", `Rendered ${filesToWrite.length} files`));
            await Effect.runPromise(tree.startTask("postinit"));
            postInitStarted = true;
          }
          return runPostInit({
            ...bound,
            ...(options.postInitIO === undefined ? {} : { io: options.postInitIO }),
            ...(options.postInitSpawner === undefined ? {} : { spawner: options.postInitSpawner }),
            ...(options.postInitCommandRunner === undefined
              ? {}
              : { commandRunner: options.postInitCommandRunner }),
            ...(resolved.root === undefined ? {} : { recipeRoot: resolved.root }),
          });
        },
      }),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    postInit = result.postInit;
    const written = new Set(result.auxiliaryFiles);
    skippedScaffold = scaffoldDests.filter((dest) => !written.has(join(directory, dest)));
  } catch (cause) {
    if (cause instanceof InitTargetExistsError) throw cause;

    await Effect.runPromise(
      tree.failTask(
        postInitStarted ? "postinit" : "render",
        postInitStarted ? "Post-init failed" : "Render failed",
      ),
    );
    await Effect.runPromise(tree.close("Initialization failed"));
    throw cause;
  }

  if (postInitStarted) {
    await Effect.runPromise(tree.completeTask("postinit", `Ran ${postInit.executed.length} actions`));
  } else {
    await Effect.runPromise(tree.completeTask("render", `Rendered ${filesToWrite.length} files`));
  }

  await Effect.runPromise(tree.close(`Initialized ${appName}`));

  return { appName, directory, answers: publicAnswers, postInit, skippedScaffold };
};
