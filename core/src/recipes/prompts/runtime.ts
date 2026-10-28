import type { PromptAnswer, RecipePrompt } from "@lando/sdk/schema";
import {
  composerChoicesForPhp,
  phpComposerIncompatibleRemediation,
  phpVersionAtLeast,
} from "../php-composer-compat.ts";
import {
  canOmitAnswer,
  missingAnswer,
  promptDefaultRaw,
  resolveDefault,
  resolveSupplied,
  validationFail,
} from "./answer-resolution.ts";
import { type ChoicesCommandRunner, createDefaultChoicesCommandRunner } from "./choices-command";
import type { PromptChrome, PromptDriver } from "./driver";
import { isDynamicChoicesPrompt, resolveDynamicChoicesPrompt } from "./dynamic-choices.ts";
import { type EditorRunner, createDefaultEditorRunner } from "./editor-command";
import { runInteractivePrompt } from "./interactive.ts";
import type { PromptIO } from "./io";

export type { PromptAnswer } from "@lando/sdk/schema";
export type PromptAnswers = Readonly<Record<string, PromptAnswer>>;

export interface CollectPromptsOptions {
  readonly prompts: ReadonlyArray<RecipePrompt>;
  readonly answers?: Readonly<Record<string, string>>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly cwd?: string;
  readonly io?: PromptIO;
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly runs?: ReadonlyArray<string>;
  readonly interactiveDriver?: PromptDriver;
  readonly editorRunner?: EditorRunner;
  readonly chrome?: Readonly<Record<string, PromptChrome>>;
}

const applyPhpComposerCompat = (
  prompt: RecipePrompt,
  supplied: string | undefined,
  phpVersion: PromptAnswer | undefined,
): RecipePrompt => {
  if (prompt.name !== "composer" || typeof phpVersion !== "string" || prompt.choices === undefined)
    return prompt;
  const effectivePrompt: RecipePrompt = {
    ...prompt,
    choices: [...composerChoicesForPhp(phpVersion, prompt.choices)],
  };
  if (supplied === "2.7.7" && phpVersionAtLeast(phpVersion, "8.5")) {
    const issue = phpComposerIncompatibleRemediation(phpVersion);
    throw validationFail(effectivePrompt, issue, issue);
  }
  return effectivePrompt;
};

export const collectPrompts = async (options: CollectPromptsOptions): Promise<PromptAnswers> => {
  const { prompts, answers = {}, yes = false, nonInteractive = false, cwd = process.cwd(), io } = options;
  const interactive = !nonInteractive && io !== undefined;
  const driver = options.interactiveDriver;
  const choicesRunner = options.choicesRunner ?? createDefaultChoicesCommandRunner();
  const editorRunner = options.editorRunner ?? createDefaultEditorRunner();
  const resolved = new Map<string, PromptAnswer>();
  for (const prompt of prompts) {
    const supplied = Object.hasOwn(answers, prompt.name) ? answers[prompt.name] : undefined;
    const effectivePrompt = applyPhpComposerCompat(prompt, supplied, resolved.get("php"));
    if (supplied === undefined && canOmitAnswer(effectivePrompt) && (yes || !interactive)) continue;
    if (isDynamicChoicesPrompt(effectivePrompt)) {
      const answer = await resolveDynamicChoicesPrompt(effectivePrompt, {
        supplied,
        runner: choicesRunner,
        io,
        interactive,
        yes,
        cwd,
        runs: options.runs,
        driver,
      });
      if (answer !== undefined) resolved.set(effectivePrompt.name, answer);
      continue;
    }
    if (supplied !== undefined) {
      resolved.set(effectivePrompt.name, await resolveSupplied(effectivePrompt, supplied, cwd));
      continue;
    }
    const def = promptDefaultRaw(effectivePrompt);
    if (yes || !interactive || io === undefined) {
      if (def.hasDefault) {
        resolved.set(effectivePrompt.name, await resolveDefault(effectivePrompt, def.raw, cwd));
        continue;
      }
      throw missingAnswer(effectivePrompt);
    }
    const answer = await runInteractivePrompt(effectivePrompt, {
      io,
      cwd,
      driver,
      editorRunner,
      chrome: options.chrome?.[effectivePrompt.name],
    });
    if (answer !== undefined) resolved.set(effectivePrompt.name, answer);
  }
  return Object.fromEntries(resolved);
};

export const parseAnswerFlags = (raw: ReadonlyArray<string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    if (key === "") continue;
    Object.defineProperty(out, key, {
      value: entry.slice(eq + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
};
