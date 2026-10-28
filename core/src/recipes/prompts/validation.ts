import type { PromptAnswer, PromptValidate, RecipePrompt } from "@lando/sdk/schema";

export type CoerceResult<T = PromptAnswer> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

export const validateText = (prompt: RecipePrompt, raw: string): CoerceResult<string> => {
  const { pattern, minLength, maxLength, message } = prompt.validate ?? {};
  if (minLength !== undefined && raw.length < minLength)
    return { ok: false, issue: message ?? `value must contain at least ${minLength} character(s)` };
  if (maxLength !== undefined && raw.length > maxLength)
    return { ok: false, issue: message ?? `value must contain at most ${maxLength} character(s)` };
  if (pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { ok: false, issue: `recipe pattern "${pattern}" is not a valid regex` };
    }
    if (!re.test(raw)) return { ok: false, issue: message ?? `value must match ${pattern}` };
  }
  return { ok: true, value: raw };
};

export const validateNumber = (prompt: RecipePrompt, raw: string): CoerceResult<number> => {
  if (raw.trim() === "") return { ok: false, issue: "a number is required" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { ok: false, issue: `"${raw}" is not a number` };
  const { min, max, integer, message } = prompt.validate ?? {};
  if (integer === true && !Number.isInteger(parsed))
    return { ok: false, issue: message ?? "value must be an integer" };
  if (min !== undefined && parsed < min) return { ok: false, issue: message ?? `value must be >= ${min}` };
  if (max !== undefined && parsed > max) return { ok: false, issue: message ?? `value must be <= ${max}` };
  return { ok: true, value: parsed };
};

export const validateConfirm = (raw: string): CoerceResult<boolean> => {
  const norm = raw.trim().toLowerCase();
  if (["y", "yes", "true", "1", "on"].includes(norm)) return { ok: true, value: true };
  if (["n", "no", "false", "0", "off"].includes(norm)) return { ok: true, value: false };
  return { ok: false, issue: `expected yes/no, got "${raw}"` };
};

export const enforceMultiSelectBounds = (
  prompt: RecipePrompt,
  count: number,
): { readonly ok: true } | { readonly ok: false; readonly issue: string } => {
  const { minItems, maxItems, min, max, message } = prompt.validate ?? {};
  const lower = minItems ?? min;
  const upper = maxItems ?? max;
  if (lower !== undefined && count < lower)
    return { ok: false, issue: message ?? `select at least ${lower} item(s)` };
  if (upper !== undefined && count > upper)
    return { ok: false, issue: message ?? `select at most ${upper} item(s)` };
  return { ok: true };
};

export const coerceItem = (
  prompt: RecipePrompt & {
    readonly validate: PromptValidate & { readonly items: NonNullable<PromptValidate["items"]> };
  },
  raw: string,
): CoerceResult<string | number | boolean> => {
  const validate = {
    ...prompt.validate.items,
    ...(prompt.validate.message === undefined ? {} : { message: prompt.validate.message }),
  };
  const itemPrompt = { ...prompt, validate };
  switch (validate.valueType) {
    case "string":
      return validateText(itemPrompt, raw);
    case "number":
      return validateNumber(itemPrompt, raw);
    case "boolean":
      return validateConfirm(raw);
    default:
      return validate.valueType satisfies never;
  }
};

/** Defaults are already typed; never stringify arrays or ambiguous enum scalars. */
export const validateTypedAnswer = (prompt: RecipePrompt, value: PromptAnswer): CoerceResult => {
  const invalid = (): CoerceResult => ({
    ok: false,
    issue: prompt.validate?.message ?? "value does not match the prompt type or choices",
  });
  const valueType = prompt.validate?.valueType;
  switch (valueType) {
    case "string":
      return typeof value === "string" ? validateText(prompt, value) : invalid();
    case "number":
      return typeof value === "number" ? validateNumber(prompt, String(value)) : invalid();
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : invalid();
    case "choice":
      return prompt.choices?.some((choice) => (typeof choice === "object" ? choice.value : choice) === value)
        ? { ok: true, value }
        : invalid();
    case "array": {
      if (!Array.isArray(value)) return invalid();
      const bounds = enforceMultiSelectBounds(prompt, value.length);
      if (!bounds.ok) return bounds;
      for (const item of value) {
        const result = validateTypedAnswer(
          { ...prompt, validate: prompt.validate?.items ?? { valueType: "choice" } },
          item,
        );
        if (!result.ok) return { ok: false, issue: prompt.validate?.message ?? result.issue };
      }
      return { ok: true, value };
    }
    case undefined:
      return { ok: true, value };
    default:
      return valueType satisfies never;
  }
};
