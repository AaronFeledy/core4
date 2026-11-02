import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";
import {
  type CoerceResult,
  coerceItem,
  enforceMultiSelectBounds,
  validateConfirm,
  validateNumber,
  validateText,
} from "./validation.ts";

const choiceValue = (choice: RecipePromptChoice): string | number | boolean =>
  typeof choice === "object" ? choice.value : choice;

export const choiceLabel = (choice: RecipePromptChoice): string =>
  typeof choice === "object" ? (choice.label ?? String(choice.value)) : String(choice);

const resolveSelection = (prompt: RecipePrompt, raw: string): CoerceResult<string | number | boolean> => {
  const choices = prompt.choices ?? [];
  if (choices.length === 0) return { ok: false, issue: "select prompt requires choices" };
  const trimmed = raw.trim();
  // Values and labels take precedence over 1-based indices, including numeric values.
  for (const choice of choices) {
    const value = choiceValue(choice);
    if (String(value) === trimmed || choiceLabel(choice) === trimmed) return { ok: true, value };
  }
  if (/^\d+$/.test(trimmed)) {
    const picked = choices[Number(trimmed) - 1];
    return picked === undefined
      ? { ok: false, issue: `selection index ${trimmed} is out of range` }
      : { ok: true, value: choiceValue(picked) };
  }
  return { ok: false, issue: `no choice matches "${trimmed}"` };
};

const resolveMultiSelection = (prompt: RecipePrompt, raw: string): CoerceResult => {
  const parts =
    raw.trim() === ""
      ? []
      : raw
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");
  const out: Array<string | number | boolean> = [];
  for (const part of parts) {
    const items = prompt.validate?.items;
    const result =
      items === undefined
        ? resolveSelection(prompt, part)
        : coerceItem({ ...prompt, validate: { ...prompt.validate, items } }, part);
    if (!result.ok) return result;
    // Source arrays preserve multiplicity; legacy multiselect remains a set.
    if (prompt.validate?.valueType === "array" || !out.includes(result.value)) out.push(result.value);
  }
  const bounds = enforceMultiSelectBounds(prompt, out.length);
  return bounds.ok ? { ok: true, value: out } : bounds;
};

const validatePath = async (prompt: RecipePrompt, raw: string, cwd: string): Promise<CoerceResult> => {
  if (raw.trim() === "" && prompt.validate?.valueType !== "string")
    return { ok: false, issue: "a path is required" };
  const text = validateText(prompt, raw);
  if (!text.ok) return text;
  const absolute = resolvePath(cwd, raw);
  if (prompt.validate?.exists === true) {
    try {
      await access(absolute);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ok: false, issue: `path does not exist: ${absolute}` };
    }
  }
  return { ok: true, value: prompt.validate?.valueType === "string" ? raw : absolute };
};

export const coerceAnswer = async (prompt: RecipePrompt, raw: string, cwd: string): Promise<CoerceResult> => {
  let result: CoerceResult;
  switch (prompt.type) {
    case "text":
    case "secret":
    case "editor":
      result = validateText(prompt, raw);
      break;
    case "number":
      result = validateNumber(prompt, raw);
      break;
    case "confirm":
      result = validateConfirm(raw);
      break;
    case "select":
      result = resolveSelection(prompt, raw);
      break;
    case "multiselect":
      result = resolveMultiSelection(prompt, raw);
      break;
    case "path":
      result = await validatePath(prompt, raw, cwd);
      break;
    default:
      return prompt.type satisfies never;
  }
  return !result.ok && prompt.validate?.message !== undefined
    ? { ok: false, issue: prompt.validate.message }
    : result;
};
