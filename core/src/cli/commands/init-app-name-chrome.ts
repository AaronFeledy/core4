import { normalizeAppSlug } from "@lando/engine/planner/naming";
import type { PromptChrome } from "../../recipes/prompts/driver";

export const APP_NAME_HELP = "Used as the Landofile name and the app id.";

export const appNamePromptChrome = (input: { readonly appRoot: string }): PromptChrome => ({
  help: APP_NAME_HELP,
  footer: [
    {
      id: "machine-name",
      render: (raw: string) =>
        raw.trim() === "" ? "Machine name: —" : `Machine name: ${normalizeAppSlug(raw, input.appRoot)}`,
    },
  ],
});

export const chromeForInitNamePrompt = (input: { readonly appRoot: string }): Readonly<
  Record<string, PromptChrome>
> => ({
  name: appNamePromptChrome(input),
});
