import { RecipeRunNotAllowedError } from "@lando/sdk/errors";

import type { ChoicesCommandResult, ChoicesCommandRunner } from "./prompts/choices-command.ts";

export const DEFAULT_RUNS_ALLOWLIST: ReadonlyArray<string> = [
  "git",
  "composer",
  "npm",
  "bun",
  "yarn",
  "pnpm",
  "pip",
  "bundle",
  "make",
];

export type RunPermission =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly allowlist: ReadonlyArray<string> }
  | { readonly kind: "warn"; readonly allowlist: ReadonlyArray<string> };

export const evaluateRunPermission = (
  runs: ReadonlyArray<string> | undefined,
  commandId: string,
): RunPermission => {
  if (runs !== undefined)
    return runs.includes(commandId) ? { kind: "allowed" } : { kind: "denied", allowlist: runs };
  return DEFAULT_RUNS_ALLOWLIST.includes(commandId)
    ? { kind: "allowed" }
    : { kind: "warn", allowlist: DEFAULT_RUNS_ALLOWLIST };
};

const formatAllowlist = (allowlist: ReadonlyArray<string>): string =>
  allowlist.length === 0 ? "<empty>" : allowlist.join(", ");

export const runNotAllowedError = (
  commandId: string,
  allowlist: ReadonlyArray<string>,
  recipe?: string,
): RecipeRunNotAllowedError =>
  new RecipeRunNotAllowedError({
    message: `Recipe command "${commandId}" is not in the recipe's runs: allowlist.`,
    commandId,
    allowlist: [...allowlist],
    remediation: `Allowed command ids are: ${formatAllowlist(allowlist)}. Add "${commandId}" to the recipe.yml runs: allowlist or remove the ctx.run/postInit command that invokes it.`,
    ...(recipe === undefined ? {} : { recipe }),
  });

export const defaultRunWarning = (commandId: string, allowlist: ReadonlyArray<string>): string =>
  `Recipe ran "${commandId}" which is outside the default runs allowlist (${formatAllowlist(allowlist)}); add an explicit runs: allowlist to your recipe to silence this.`;

export interface RecipeRunContext {
  readonly run: (id: string, args?: ReadonlyArray<string>) => Promise<ChoicesCommandResult>;
}

export const createRecipeRunContext = (options: {
  readonly runs: ReadonlyArray<string> | undefined;
  readonly runner: ChoicesCommandRunner;
  readonly onWarn?: (msg: string) => void;
  readonly recipe?: string;
}): RecipeRunContext => ({
  run: async (id, args = []) => {
    const permission = evaluateRunPermission(options.runs, id);
    if (permission.kind === "denied") throw runNotAllowedError(id, permission.allowlist, options.recipe);
    if (permission.kind === "warn") options.onWarn?.(defaultRunWarning(id, permission.allowlist));
    return options.runner({ command: id, args });
  },
});
