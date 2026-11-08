import { isLandofileOverride, isLandofileReset, isPlainRecord, override } from "@lando/sdk/landofile";

export const includeEntryPath = (path: readonly (string | number)[]): boolean =>
  path.length === 2 &&
  ((path[0] === "includes" && typeof path[1] === "number") ||
    (path[0] === "toolingIncludes" && typeof path[1] === "string"));

export const includeConditionPath = (path: readonly (string | number)[]): boolean =>
  path.at(-1) === "when" && includeEntryPath(path.slice(0, -1));

const containsCondition = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsCondition);
  if (!isPlainRecord(value)) return false;
  return Object.hasOwn(value, "when") || Object.values(value).some(containsCondition);
};

export const hasIncludeConditions = (document: Record<string, unknown>): boolean =>
  containsCondition(document.includes) || containsCondition(document.toolingIncludes);

export const withoutIncludeCondition = (entry: Record<string, unknown>): Record<string, unknown> => {
  const { when: _when, ...rest } = entry;
  return rest;
};

export const withoutIncludeConditions = (document: Record<string, unknown>): Record<string, unknown> => {
  const entry = (value: unknown): unknown => (isPlainRecord(value) ? withoutIncludeCondition(value) : value);
  const map = (value: unknown, field: "includes" | "toolingIncludes"): unknown => {
    if (isLandofileReset(value)) return value;
    if (isLandofileOverride(value)) return override(map(value.value, field));
    if (field === "includes" && Array.isArray(value)) return value.map(entry);
    if (field === "toolingIncludes" && isPlainRecord(value))
      return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, entry(value)]));
    return value;
  };
  return {
    ...document,
    ...(Object.hasOwn(document, "includes") ? { includes: map(document.includes, "includes") } : {}),
    ...(Object.hasOwn(document, "toolingIncludes")
      ? { toolingIncludes: map(document.toolingIncludes, "toolingIncludes") }
      : {}),
  };
};
