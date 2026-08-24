import { basename } from "node:path";

import type { RecipePrompt } from "@lando/sdk/schema";

const APP_NAME_PROMPT = "name";
const FALLBACK_APP_NAME = "app";

export const defaultAppNameFromCwd = (cwd: string): string => {
  const slug = basename(cwd)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return FALLBACK_APP_NAME;
  return /^[a-z]/.test(slug) ? slug : `${FALLBACK_APP_NAME}-${slug}`;
};

export const withAppNameDefault = (
  prompts: ReadonlyArray<RecipePrompt>,
  cwd: string,
): ReadonlyArray<RecipePrompt> => {
  const fallback = defaultAppNameFromCwd(cwd);
  return prompts.map((prompt) => {
    if (prompt.name !== APP_NAME_PROMPT || prompt.type !== "text" || prompt.default !== undefined) {
      return prompt;
    }
    return { ...prompt, default: fallback };
  });
};
