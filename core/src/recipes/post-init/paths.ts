import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { RecipePostInitError } from "@lando/sdk/errors";
import type { RecipePostInitAction } from "@lando/sdk/schema";
import type { RunPostInitOptions } from "./runtime";

interface RecipeActionContext {
  readonly options: RunPostInitOptions;
  readonly index: number;
}

const realpathOrUndefined = (path: string): Promise<string | undefined> =>
  realpath(path).then(
    (value) => value,
    () => undefined,
  );
const isInside = (parent: string, candidate: string) =>
  candidate === parent || candidate.startsWith(`${parent}${sep}`);

const nearestExistingRealpath = async (target: string): Promise<string> => {
  let current = target;
  for (;;) {
    const resolved = await realpathOrUndefined(current);
    if (resolved !== undefined) return resolved;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
};

export const resolveBunCwd = async (
  action: Extract<RecipePostInitAction, { type: "bun" }>,
  context: RecipeActionContext,
): Promise<string> => {
  const { index, options } = context;
  const { verb } = action;
  const recipe = options.recipeId;
  const raw = typeof action.cwd === "string" && action.cwd.length > 0 ? action.cwd : ".";
  if (raw.split(/[\\/]/u).some((segment) => segment === ".."))
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun ${verb}): cwd "${raw}" must not contain ".." segments.`,
      recipe,
      actionIndex: index,
      actionType: "bun",
      actionVerb: verb,
      kind: "outside-destination",
      remediation:
        "Set `cwd:` to the recipe destination or a subdirectory of it. Path traversal via `..` is rejected.",
    });
  const initial = isAbsolute(raw) ? raw : resolve(options.destination, raw);
  const destination = (await realpathOrUndefined(options.destination)) ?? options.destination;
  const cwd = (await realpathOrUndefined(initial)) ?? initial;
  if (!isInside(destination, cwd))
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun ${verb}): cwd "${raw}" resolves outside the recipe destination (${destination}).`,
      recipe,
      actionIndex: index,
      actionType: "bun",
      actionVerb: verb,
      kind: "outside-destination",
      remediation:
        "Set `cwd:` to the recipe destination or a subdirectory of it. Symlinks that escape the destination are rejected.",
    });
  return cwd;
};

export const ensurePackageJson = async (
  cwd: string,
  verb: string,
  context: RecipeActionContext,
): Promise<void> => {
  const path = `${cwd}${sep}package.json`;
  if (await Bun.file(path).exists()) return;
  throw new RecipePostInitError({
    message: `postInit[${context.index}] (bun ${verb}): no package.json found at ${path}.`,
    recipe: context.options.recipeId,
    actionIndex: context.index,
    actionType: "bun",
    actionVerb: verb,
    kind: "missing-package-json",
    remediation: `Author a recipe that writes package.json before the bun ${verb} action runs, or remove the action.`,
  });
};

export const resolveCreateDest = async (
  rawDest: string,
  cwd: string,
  context: RecipeActionContext,
): Promise<string> => {
  const { index, options } = context;
  if (rawDest.split(/[\\/]/u).some((segment) => segment === ".."))
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun create): dest "${rawDest}" must not contain ".." segments.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "create",
      kind: "outside-destination",
      remediation:
        "Set `dest:` to a path inside the recipe destination. Path traversal via `..` is rejected.",
    });
  const target = isAbsolute(rawDest) ? rawDest : resolve(cwd, rawDest);
  const destination = (await realpathOrUndefined(options.destination)) ?? options.destination;
  const anchor = await nearestExistingRealpath(target);
  if (!isInside(destination, anchor))
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun create): dest "${rawDest}" resolves outside the recipe destination (${destination}).`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "create",
      kind: "outside-destination",
      remediation:
        "Set `dest:` to a path inside the recipe destination. Absolute paths and symlinks that escape it are rejected.",
    });
  return target;
};

export const resolveScriptPath = async (rawScript: string, context: RecipeActionContext): Promise<string> => {
  const { index, options } = context;
  const recipeRoot = options.recipeRoot;
  if (recipeRoot === undefined)
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): no recipe source tree is available to resolve "${rawScript}".`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "invalid-argv",
      remediation:
        "The `script` verb requires a recipe with an on-disk source tree (`templates/` or `assets/`); bundled in-binary recipes cannot use it.",
    });
  if (rawScript.split(/[\\/]/u).some((segment) => segment === ".."))
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): script "${rawScript}" must not contain ".." segments.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "outside-recipe",
      remediation: "Set `script:` to a path under the recipe's `templates/` or `assets/` tree.",
    });
  const initial = isAbsolute(rawScript) ? rawScript : resolve(recipeRoot, rawScript);
  const root = (await realpathOrUndefined(recipeRoot)) ?? recipeRoot;
  const script = await realpathOrUndefined(initial);
  if (script === undefined)
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): script file "${rawScript}" was not found under the recipe source tree.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "invalid-argv",
      remediation:
        "Ship the script under the recipe's `templates/` or `assets/` tree, or fix the `script:` path.",
    });
  if (!isInside(root, script))
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): script "${rawScript}" resolves outside the recipe source tree (${root}).`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "outside-recipe",
      remediation:
        "Set `script:` to a path inside the recipe's `templates/` or `assets/` tree. Absolute paths and symlinks that escape it are rejected.",
    });
  return script;
};
