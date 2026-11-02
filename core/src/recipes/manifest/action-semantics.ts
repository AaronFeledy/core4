import type { RecipePostInitAction, RecipePrompt } from "@lando/sdk/schema";
import { postInitAuthorizationIssue } from "../post-init/authorization.ts";

export const postInitSemanticIssues = (
  action: RecipePostInitAction,
  prompts?: readonly RecipePrompt[],
): readonly string[] => {
  const issues: string[] = [];
  const authorization = postInitAuthorizationIssue(action, prompts);
  if (authorization !== undefined) issues.push(authorization);
  switch (action.type) {
    case "gitInit":
      issues.push("post-init gitInit is not implemented.");
      return issues;
    case "command":
    case "message":
      return issues;
    case "bun":
      break;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  switch (action.verb) {
    case "add": {
      const specs = [
        action.dependencies,
        action.devDependencies,
        action.peerDependencies,
        action.optionalDependencies,
      ].flatMap((category) => category ?? []);
      if (specs.length === 0) issues.push("(bun add): at least one dependency category must be non-empty.");
      for (const spec of specs) {
        if (spec.trim() === "" || spec.trim().startsWith("-"))
          issues.push(`(bun add): package spec "${spec}" is invalid; flags and empty specs are not allowed.`);
      }
      break;
    }
    case "create":
      if (action.template.trim() === "") issues.push("(bun create): template must not be empty.");
      else if (action.template.trim().startsWith("-"))
        issues.push(`(bun create): template "${action.template}" is invalid; it must not begin with "-".`);
      break;
    case "run":
    case "script":
      if (action.script.trim() === "") issues.push(`(bun ${action.verb}): script must not be empty.`);
      else if (action.script.trim().startsWith("-"))
        issues.push(
          `(bun ${action.verb}): script "${action.script}" is invalid; it must not begin with "-".`,
        );
      break;
    case "x":
      if (action.spec.trim() === "") issues.push("(bun x): spec must not be empty.");
      else if (action.spec.trim().startsWith("-"))
        issues.push(`(bun x): spec "${action.spec}" is invalid; it must not begin with "-".`);
      break;
    case "install":
      break;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  return issues;
};
