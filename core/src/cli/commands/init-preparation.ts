import { resolve } from "node:path";
import { RecipeMissingAnswerError } from "@lando/sdk/errors";
import type { PromptBatchOptions, RecipeManifest, RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { type InteractionPrompter, makePromiseInteractionPrompter } from "../../interaction/prompter";
import { makeDefaultResolveInteractionDriver, makeInteractionService } from "../../interaction/service";
import { getInteractionServiceOverride } from "../../interaction/testing-override";
import { acquireInitRecipe } from "../../recipes/acquire";
import { getRecipeCatalog } from "../../recipes/catalog";
import { type PreparedRecipeInit, prepareRecipeInit } from "../../recipes/prepared-init";
import type { ChoicesCommandRunner, PromptAnswers } from "../../recipes/prompts/index";
import { readAnswersFile } from "../prompts/answer-flags";
import { activeRendererMode } from "../renderer-mode-state";
import { withAppNameDefault } from "./init-app-name";
import { chromeForInitNamePrompt } from "./init-app-name-chrome";
import { resolveInitDestination } from "./init-destination";
import {
  initOptionPrompts,
  typedInitAnswers,
  validateSuppliedInitSecretAnswers,
} from "./init-option-answers";
import type { InitAppOptions } from "./init-options";
import { parseInitSourceFlags } from "./init-source";

const APP_NAME_PROMPT = "name";
const RECIPE_SELECT_PROMPT = "__recipe__";

export const loadRecipeEncoder = async (): Promise<ConfigTranslatorShape> => {
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
  return { name: RECIPE_SELECT_PROMPT, type: "select", message: "Pick a recipe", choices };
};

const resolveRecipeSelection = async (
  options: InitAppOptions,
  interaction: InteractionPrompter | undefined,
): Promise<string> => {
  if (options.recipe !== undefined && options.recipe !== "") return options.recipe;
  if (options.nonInteractive === true || interaction === undefined || options.yes === true) {
    return "node-postgres";
  }
  const collected = await interaction.promptAll([buildRecipeSelectPrompt()], {
    cwd: options.cwd,
    mode: "interactive",
  });
  const picked = collected[RECIPE_SELECT_PROMPT];
  return typeof picked === "string" ? picked : (sortedRecipeCatalog()[0]?.id ?? "node-postgres");
};

export const stripSecretInitAnswers = (
  prompts: ReadonlyArray<RecipePrompt>,
  answers: PromptAnswers,
): PromptAnswers => {
  const secretNames = new Set(
    prompts.filter((prompt) => prompt.type === "secret").map((prompt) => prompt.name),
  );
  return Object.fromEntries(Object.entries(answers).filter(([name]) => !secretNames.has(name)));
};

const composeAnswers = async (
  options: InitAppOptions,
  prompts: readonly RecipePrompt[],
): Promise<Record<string, string>> => {
  const fileAnswers =
    options.answersFile === undefined ? {} : await readAnswersFile(resolve(options.cwd, options.answersFile));
  validateSuppliedInitSecretAnswers(prompts, fileAnswers);
  validateSuppliedInitSecretAnswers(prompts, options.answers ?? {});
  const out: Record<string, string> = { ...fileAnswers, ...(options.answers ?? {}) };
  if (options.name !== undefined && options.name.trim() !== "") {
    out[APP_NAME_PROMPT] = options.name.trim();
  }
  return out;
};

// Standalone callers still route through the single InteractionService chokepoint.
const defaultInitPrompter = (
  choicesRunner?: ChoicesCommandRunner,
  signal?: AbortSignal,
): InteractionPrompter =>
  makePromiseInteractionPrompter(
    getInteractionServiceOverride() ??
      makeInteractionService({
        resolveDriver:
          activeRendererMode === "lando" ? makeDefaultResolveInteractionDriver() : async () => undefined,
        ...(choicesRunner === undefined ? {} : { choicesRunner }),
      }),
    signal,
  );

type InternalPromptBatchOptions = PromptBatchOptions & {
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly chrome?: ReturnType<typeof chromeForInitNamePrompt>;
};

export const prepareInitApp = async (
  options: InitAppOptions,
): Promise<{
  readonly prepared: PreparedRecipeInit;
  readonly directory: string;
  readonly publicAnswers: PromptAnswers;
  readonly appName: string;
  readonly manifest: RecipeManifest;
  readonly interaction: InteractionPrompter;
  readonly reviewEligible: boolean;
}> => {
  const { cwd } = options;
  const prompter = options.interaction ?? defaultInitPrompter(options.choicesRunner, options.signal);
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
      : await resolveRecipeSelection(options, interactivePrompter);
  const { resolution, questionnaire: manifest } = await acquireInitRecipe(
    options,
    recipeRef,
    interactivePrompter,
  );
  const directory = resolveInitDestination({
    cwd,
    ...(options.destination === undefined ? {} : { destination: options.destination }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });

  const prompts = withAppNameDefault(
    [
      {
        name: "name",
        type: "text",
        message: "App name",
        validate: { pattern: "^[a-z][a-z0-9-]*$", message: "App name must be lowercase kebab-case." },
      },
      ...initOptionPrompts(manifest),
    ],
    options.destination ?? cwd,
  );
  const presetAnswers = await composeAnswers(options, prompts);
  typedInitAnswers(manifest.snapshot.optionTypes, stripSecretInitAnswers(prompts, presetAnswers));
  const reviewEligible =
    options.yes !== true &&
    options.nonInteractive !== true &&
    ((sourceOptions.source === undefined && (options.recipe === undefined || options.recipe === "")) ||
      prompts.some(({ name }) => !Object.hasOwn(presetAnswers, name)));
  const promptOptions = {
    answers: presetAnswers,
    cwd,
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    interactive: options.nonInteractive !== true,
    ...(manifest.runs === undefined ? {} : { runs: manifest.runs }),
    ...(options.choicesRunner === undefined ? {} : { choicesRunner: options.choicesRunner }),
    chrome: chromeForInitNamePrompt({ appRoot: options.destination ?? cwd }),
  } satisfies InternalPromptBatchOptions;
  const prompted = await prompter.promptAll(prompts, promptOptions);
  options.signal?.throwIfAborted();
  const { compileResolvedRecipe } = await import("../../recipes/compiled-source");
  const compiled = await Effect.runPromise(
    compileResolvedRecipe(resolution),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  const encoder = await loadRecipeEncoder();

  // Prompt collection validates declared prompts. Preserve additional explicit
  // options for decomposers, which own their recipe-specific option contract.
  const collected = { ...presetAnswers, ...prompted };
  const publicAnswers = typedInitAnswers(
    compiled.snapshot.optionTypes,
    stripSecretInitAnswers(prompts, collected),
  );
  const appName = collected[APP_NAME_PROMPT];
  if (typeof appName !== "string" || appName === "") {
    throw new Error(`Recipe "${recipeRef}" requires a text answer for prompt 'name'.`);
  }
  const secretAnswers = Object.fromEntries(
    prompts
      .filter(({ type }) => type === "secret")
      .flatMap(({ name }) => {
        const value = collected[name];
        return typeof value === "string" ? [[name, value]] : [];
      }),
  );
  const prepared = await Effect.runPromise(
    prepareRecipeInit({
      compiled,
      appRoot: directory,
      appName,
      answers: publicAnswers,
      secretAnswers,
      encoder,
    }),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  if (prepared.status === "requires-input")
    throw new RecipeMissingAnswerError({
      promptName: prepared.missing[0] ?? "",
      message: "Recipe initialization requires additional answers.",
      remediation: "Supply the missing declared options using --answer name=value.",
    });
  return {
    prepared,
    directory,
    publicAnswers: { ...publicAnswers, ...prepared.answers },
    appName,
    manifest: compiled.manifest,
    interaction: prompter,
    reviewEligible,
  };
};
