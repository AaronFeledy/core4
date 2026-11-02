import { RecipePromptValidationError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import {
  ConfigTranslateSecretReference,
  PromptAnswer,
  type RecipeManifest,
  type RecipeOptionType,
  type RecipePrompt,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import type { PromptAnswers } from "../../recipes/prompts/index";

export const validateSuppliedInitSecretAnswers = (
  prompts: readonly RecipePrompt[],
  answers: PromptAnswers,
): void => {
  for (const prompt of prompts) {
    if (prompt.type !== "secret" || !Object.hasOwn(answers, prompt.name)) continue;
    if (
      prompt.disposition?.kind === "secret-store" &&
      Schema.is(ConfigTranslateSecretReference)({
        disposition: "secret-store",
        reference: answers[prompt.name],
      })
    )
      continue;
    throw new RecipePromptValidationError({
      promptName: prompt.name,
      promptType: "secret",
      issue: "Secret answer transport is not permitted.",
      message: `Invalid answer transport for secret recipe option ${prompt.name}.`,
      remediation:
        "Answer init-only secrets through secure interactive prompting; supply only existing ${secret:...} references for stored secrets.",
    });
  }
};

const typedOption = (descriptor: RecipeOptionType, value: unknown): unknown => {
  if (optionValueMatchesDescriptor(descriptor, value)) return value;
  if (descriptor.kind === "optional") return typedOption(descriptor.inner, value);
  if (typeof value !== "string") return value;
  switch (descriptor.kind) {
    case "string":
      return value;
    case "enum":
      return descriptor.values.find((candidate) => String(candidate) === value) ?? value;
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "number":
      return value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
    case "array": {
      try {
        return JSON.parse(value);
      } catch (error) {
        if (error instanceof SyntaxError) return value;
        throw error;
      }
    }
    default:
      return descriptor satisfies never;
  }
};
export const typedInitAnswers = (
  types: Readonly<Record<string, RecipeOptionType>>,
  values: PromptAnswers,
): PromptAnswers =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const descriptor = types[name];
      if (name === "name" || descriptor === undefined) return [name, value];
      const typed = typedOption(descriptor, value);
      if (!optionValueMatchesDescriptor(descriptor, typed) || !Schema.is(PromptAnswer)(typed))
        throw new RecipePromptValidationError({
          promptName: name,
          promptType: descriptor.kind,
          issue: "Option does not match its declared type.",
          message: `Invalid answer for recipe option ${name}.`,
          remediation: "Supply a value matching the recipe option descriptor.",
        });
      return [name, typed];
    }),
  );

export const initOptionPrompts = (manifest: RecipeManifest): readonly RecipePrompt[] => {
  const prompts = [...(manifest.prompts ?? [])];
  for (const [name, descriptor] of Object.entries(manifest.snapshot?.optionTypes ?? {})) {
    if (prompts.some((prompt) => prompt.name === name) || descriptor.kind === "optional") continue;
    const value = manifest.snapshot?.defaults[name];
    let type: RecipePrompt["type"];
    switch (descriptor.kind) {
      case "boolean":
        type = "confirm";
        break;
      case "number":
        type = "number";
        break;
      case "enum":
        type = "select";
        break;
      case "array":
      case "string":
        type = "text";
        break;
      default:
        descriptor satisfies never;
        continue;
    }
    prompts.push({
      name,
      type,
      message: name,
      ...(value === undefined ? {} : { default: Array.isArray(value) ? JSON.stringify(value) : value }),
      ...(descriptor.kind === "enum" ? { choices: descriptor.values } : {}),
    });
  }
  return prompts;
};
