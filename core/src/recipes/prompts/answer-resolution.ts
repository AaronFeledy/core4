import { RecipeMissingAnswerError, RecipePromptValidationError } from "@lando/sdk/errors";
import type { PromptAnswer, RecipePrompt } from "@lando/sdk/schema";
import { coerceAnswer } from "./coerce.ts";
import { validateTypedAnswer } from "./validation.ts";

export const canOmitAnswer = (prompt: RecipePrompt): boolean =>
  prompt.validate?.optional === true && prompt.default === undefined;

export const promptDefaultRaw = (
  prompt: RecipePrompt,
): { readonly hasDefault: true; readonly raw: string } | { readonly hasDefault: false } => {
  if (prompt.default === undefined) return { hasDefault: false };
  return { hasDefault: true, raw: String(prompt.default) };
};

export const missingAnswer = (prompt: RecipePrompt): RecipeMissingAnswerError =>
  new RecipeMissingAnswerError({
    message: `Missing required answer for prompt "${prompt.name}".`,
    promptName: prompt.name,
    remediation: `Provide it via --answer ${prompt.name}=<value> or add a default to the recipe.`,
  });

export const validationFail = (
  prompt: RecipePrompt,
  issue: string,
  remediation: string,
): RecipePromptValidationError =>
  new RecipePromptValidationError({
    message: `Invalid value for prompt "${prompt.name}": ${issue}`,
    promptName: prompt.name,
    promptType: prompt.type,
    issue,
    remediation,
  });

export const resolveSupplied = async (
  prompt: RecipePrompt,
  supplied: string,
  cwd: string,
): Promise<PromptAnswer> => {
  const result = await coerceAnswer(prompt, supplied, cwd);
  if (!result.ok)
    throw validationFail(
      prompt,
      result.issue,
      `Update --answer ${prompt.name}=<value> with a value that satisfies the recipe constraint.`,
    );
  return result.value;
};

export const resolveDefault = async (
  prompt: RecipePrompt,
  defaultRaw: string,
  cwd: string,
): Promise<PromptAnswer> => {
  const result =
    prompt.validate?.valueType !== undefined && prompt.default !== undefined
      ? validateTypedAnswer(prompt, prompt.default)
      : await coerceAnswer(prompt, defaultRaw, cwd);
  if (!result.ok)
    throw validationFail(
      prompt,
      result.issue,
      "The recipe default for this prompt failed validation; report this to the recipe author.",
    );
  return result.value;
};
