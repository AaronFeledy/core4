import type { PromptDriverRequestLike, SelectOptionLike } from "./prompt-driver-types.ts";

const choiceValue = (choice: unknown): unknown => {
  if (choice !== null && typeof choice === "object" && "value" in choice) {
    return (choice as { value?: unknown }).value;
  }
  return choice;
};

export const choiceLabel = (choice: unknown): string => {
  if (choice !== null && typeof choice === "object") {
    const record = choice as { label?: unknown; name?: unknown; value?: unknown; description?: unknown };
    const candidate = record.label ?? record.name ?? record.value;
    return String(candidate ?? "");
  }
  return String(choice);
};

export const choiceDescription = (choice: unknown): string | undefined => {
  if (choice !== null && typeof choice === "object") {
    const description = (choice as { description?: unknown }).description;
    return description === undefined ? undefined : String(description);
  }
  return undefined;
};

// Exact value or label match wins before the 1-based index fallback, so a numeric-valued choice matches its literal value.
const resolveTokenIndex = (choices: ReadonlyArray<unknown>, token: string): number | undefined => {
  const trimmed = token.trim();
  if (trimmed === "") return undefined;
  const byValueOrLabel = choices.findIndex(
    (choice) => String(choiceValue(choice)) === trimmed || choiceLabel(choice) === trimmed,
  );
  if (byValueOrLabel >= 0) return byValueOrLabel;
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    if (index >= 0 && index < choices.length) return index;
  }
  return undefined;
};

export const selectedChoiceIndex = (
  choices: ReadonlyArray<unknown>,
  defaultRaw: string | undefined,
): number => {
  if (defaultRaw === undefined) return 0;
  return resolveTokenIndex(choices, defaultRaw) ?? 0;
};

export const isYesDefault = (defaultRaw: string | undefined): boolean =>
  defaultRaw !== undefined && /^(y|yes|true|1|on)$/i.test(defaultRaw.trim());

export const isDeclinedType = (type: string): boolean => type === "secret";

export const readPromptType = (request: PromptDriverRequestLike): string => {
  if (request.mode === "confirm") return "confirm";
  if (request.mode === "manual-choice") return "manual-choice";
  return request.prompt.type;
};

export const checkedIndicesFromDefault = (
  choices: ReadonlyArray<unknown>,
  defaultRaw: string | undefined,
): Set<number> => {
  const checked = new Set<number>();
  if (defaultRaw === undefined) return checked;
  for (const token of defaultRaw.split(",")) {
    const index = resolveTokenIndex(choices, token);
    if (index !== undefined) checked.add(index);
  }
  return checked;
};

export const checkboxOption = (choice: unknown, index: number, checked: boolean): SelectOptionLike => ({
  name: `${checked ? "[x]" : "[ ]"} ${choiceLabel(choice)}`,
  description: "",
  value: String(index + 1),
});
