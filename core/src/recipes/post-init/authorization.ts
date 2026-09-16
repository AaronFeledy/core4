import { RecipePostInitError } from "@lando/sdk/errors";
import {
  evaluateTemplateEither,
  expressionTouchesOnlyScopes,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import type { RecipePostInitAction, RecipePrompt } from "@lando/sdk/schema";
import { Either } from "effect";
import { RECIPE_POST_INIT_COMMAND_IDS } from "../../cli/allowlists/recipe-post-init";

const allowed: readonly string[] = RECIPE_POST_INIT_COMMAND_IDS;
const answerGuard = (when: string | undefined): string | undefined => {
  const source = when?.trim() ?? "";
  const expression = source.startsWith("{{") && source.endsWith("}}") ? source.slice(2, -2).trim() : source;
  return /^options\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expression)?.[1];
};

export const postInitAuthorizationIssue = (
  action: RecipePostInitAction,
  prompts?: readonly RecipePrompt[],
): string | undefined => {
  if (action.when !== undefined) {
    const when = action.when.trim();
    if (when.length === 0 || when.length > 8192) return "Invalid when expression size.";
    const parsed = parseExpressionEither(when.startsWith("{{") ? when : `{{ ${when} }}`, {
      filePath: "recipe",
    });
    if (Either.isLeft(parsed) || !expressionTouchesOnlyScopes(parsed.right, ["options"])) {
      return "Invalid when expression or forbidden scope.";
    }
  }
  switch (action.type) {
    case "command": {
      if (!allowed.includes(action.cmd))
        return "Command must be an exact canonical id in the recipe post-init allowlist; runs cannot grant command authority.";
      if (action.cmd !== "app:start") return undefined;
      const name = answerGuard(action.when);
      if (name === undefined) return "app:start requires an explicit options.<answer> when guard.";
      const prompt = prompts?.find((candidate) => candidate.name === name);
      if (prompts !== undefined && prompt === undefined)
        return "app:start requires a declared opt-in prompt.";
      if (
        prompt !== undefined &&
        (prompt.type !== "confirm" ||
          (prompt.default !== undefined && prompt.default !== false && prompt.default !== "false"))
      ) {
        return "The app:start opt-in prompt must be confirm with a false default.";
      }
      return undefined;
    }
    case "bun":
    case "message":
    case "gitInit":
      return undefined;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

export const shouldRunPostInitAction = (
  action: RecipePostInitAction,
  context: { readonly recipeId: string; readonly answers: Readonly<Record<string, unknown>> },
  index: number,
): boolean => {
  const fail = (message: string): never => {
    throw new RecipePostInitError({
      message: `postInit[${index}]: ${message}`,
      recipe: context.recipeId,
      actionIndex: index,
      actionType: action.type,
      kind: "invalid-argv",
      remediation:
        "Use an allowlisted canonical command and a bounded boolean when expression over options. Starting services requires an affirmative answer.",
    });
  };
  const issue = postInitAuthorizationIssue(action);
  if (issue !== undefined) return fail(issue);
  const when = action.when?.trim();
  if (when === undefined) return true;
  if (when.length === 0 || when.length > 8192) return fail("Invalid when expression size.");
  const name = action.type === "command" && action.cmd === "app:start" ? answerGuard(when) : undefined;
  if (name !== undefined && context.answers[name] !== true && context.answers[name] !== "true") return false;
  const parsed = parseExpressionEither(when.startsWith("{{") ? when : `{{ ${when} }}`, {
    filePath: context.recipeId,
  });
  if (Either.isLeft(parsed) || !expressionTouchesOnlyScopes(parsed.right, ["options"]))
    return fail("Invalid when expression or forbidden scope.");
  const options = Object.fromEntries(
    Object.entries(context.answers).map(([key, value]) => [
      key,
      value === "true" ? true : value === "false" ? false : value,
    ]),
  );
  const result = evaluateTemplateEither(
    parsed.right,
    { options },
    {
      budget: {
        maxSteps: 10000,
        maxDepth: 64,
        maxOutputBytes: 65536,
        maxCollectionSize: 1000,
      },
    },
  );
  if (Either.isLeft(result) || typeof result.right !== "boolean")
    return fail("when must evaluate to a boolean within the evaluation budget.");
  return result.right;
};
