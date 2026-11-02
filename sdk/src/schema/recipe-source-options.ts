import { Result } from "effect";
import { optionValueMatchesDescriptor } from "../recipes/option-types.ts";
import type { PromptValidate } from "./prompt.ts";
import type { RecipeOptionValue } from "./recipe-identity.ts";
import type { RecipeOptionType } from "./recipe-snapshot.ts";
import { type RecipeSourceCompileError, recipeSourceFailure } from "./recipe-source-error.ts";
import type { RecipeSource, RecipeSourcePrompt } from "./recipe-source.ts";
import type { RecipePrompt } from "./recipe.ts";

const validDescriptor = (type: RecipeOptionType): boolean => {
  switch (type.kind) {
    case "string": {
      if ((type.minLength ?? 0) < 0 || (type.maxLength ?? Number.POSITIVE_INFINITY) < (type.minLength ?? 0))
        return false;
      if (type.pattern === undefined) return true;
      try {
        new RegExp(type.pattern);
        return true;
      } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
      }
    }
    case "number":
      return (type.max ?? Number.POSITIVE_INFINITY) >= (type.min ?? Number.NEGATIVE_INFINITY);
    case "boolean":
      return true;
    case "enum":
      return (
        new Set(type.values).size === type.values.length &&
        type.values.every((value) => typeof value !== "number" || Number.isFinite(value))
      );
    case "array":
      return (
        validDescriptor(type.items) &&
        (type.minItems ?? 0) >= 0 &&
        (type.maxItems ?? Number.POSITIVE_INFINITY) >= (type.minItems ?? 0)
      );
    case "optional":
      return validDescriptor(type.inner);
    default:
      return type satisfies never;
  }
};

const promptType = (descriptor: RecipeOptionType): RecipePrompt["type"] => {
  switch (descriptor.kind) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "boolean":
      return "confirm";
    case "enum":
      return "select";
    case "array":
      return "multiselect";
    case "optional":
      return promptType(descriptor.inner);
    default:
      return descriptor satisfies never;
  }
};

const promptChoices = (descriptor: RecipeOptionType): RecipePrompt["choices"] => {
  switch (descriptor.kind) {
    case "enum":
      return descriptor.values;
    case "array":
      return promptChoices(descriptor.items);
    case "optional":
      return promptChoices(descriptor.inner);
    case "string":
    case "number":
    case "boolean":
      return undefined;
    default:
      return descriptor satisfies never;
  }
};

const promptValidation = (descriptor: RecipeOptionType): PromptValidate => {
  switch (descriptor.kind) {
    case "string":
    case "number": {
      const { kind, ...constraints } = descriptor;
      return { valueType: kind, ...constraints };
    }
    case "boolean":
      return { valueType: "boolean" };
    case "enum":
      return { valueType: "choice" };
    case "optional":
      return { ...promptValidation(descriptor.inner), optional: true };
    case "array": {
      const { kind, items, ...bounds } = descriptor;
      if (items.kind === "enum") return { valueType: kind, ...bounds };
      const { kind: valueType, ...constraints } = items;
      return { valueType: kind, ...bounds, items: { valueType, ...constraints } };
    }
    default:
      return descriptor satisfies never;
  }
};

const presentationMatches = (presentation: RecipeSourcePrompt, descriptor: RecipeOptionType): boolean => {
  const expected = promptType(descriptor);
  if (
    presentation.type !== undefined &&
    presentation.type !== expected &&
    !(expected === "text" && ["path", "editor"].includes(presentation.type))
  )
    return false;
  const choices = promptChoices(descriptor);
  return (
    presentation.choices === undefined ||
    (choices !== undefined &&
      presentation.choices.length === choices.length &&
      presentation.choices.every(
        (choice, index) => (typeof choice === "object" ? choice.value : choice) === choices[index],
      ))
  );
};

export const compileSourceOptions = (
  source: RecipeSource,
): Result.Result<
  {
    readonly optionTypes: Record<string, RecipeOptionType>;
    readonly defaults: Record<string, RecipeOptionValue>;
    readonly prompts: RecipePrompt[];
  },
  RecipeSourceCompileError
> => {
  const optionTypes: Record<string, RecipeOptionType> = {};
  const defaults: Record<string, RecipeOptionValue> = {};
  const prompts: RecipePrompt[] = [];
  for (const [name, option] of Object.entries(source.options ?? {})) {
    if ("drop" in option) continue;
    if ("disposition" in option) {
      if (option.prompt?.type !== undefined && option.prompt.type !== "secret")
        return Result.fail(recipeSourceFailure(source.id, "secret-invalid", `options.${name}.prompt`));
      prompts.push({
        ...(option.prompt?.deprecated === undefined ? {} : { deprecated: option.prompt.deprecated }),
        name,
        message: option.prompt?.message ?? name,
        type: "secret",
        disposition: option.disposition,
      });
      continue;
    }
    if (!validDescriptor(option.type))
      return Result.fail(recipeSourceFailure(source.id, "option-descriptor", `options.${name}.type`));
    if (option.default !== undefined && !optionValueMatchesDescriptor(option.type, option.default))
      return Result.fail(recipeSourceFailure(source.id, "option-default", `options.${name}.default`));
    Object.defineProperty(optionTypes, name, { value: option.type, enumerable: true });
    if (option.default !== undefined)
      Object.defineProperty(defaults, name, { value: option.default, enumerable: true });
    if (option.prompt === undefined) continue;
    if (!presentationMatches(option.prompt, option.type))
      return Result.fail(recipeSourceFailure(source.id, "option-descriptor", `options.${name}.prompt`));
    const choices = option.prompt.choices ?? promptChoices(option.type);
    const { validationMessage, ...presentation } = option.prompt;
    prompts.push({
      ...presentation,
      name,
      message: option.prompt.message ?? name,
      type: option.prompt.type ?? promptType(option.type),
      ...(option.default === undefined ? {} : { default: option.default }),
      ...(choices === undefined ? {} : { choices }),
      validate: {
        ...promptValidation(option.type),
        ...(validationMessage === undefined ? {} : { message: validationMessage }),
      },
    });
  }
  return Result.succeed({ optionTypes, defaults, prompts });
};
