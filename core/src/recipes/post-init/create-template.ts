import { RecipePostInitError } from "@lando/sdk/errors";

export const resolveCreateTemplate = (
  template: string,
  index: number,
  context: { readonly recipeId: string; readonly answers: Readonly<Record<string, unknown>> },
): string => {
  const resolved = template.replace(/\$\{answers\.([A-Za-z0-9_-]+)\}/gu, (_match, name: string) => {
    const value = Object.hasOwn(context.answers, name) ? context.answers[name] : undefined;
    if (value === undefined || value === null || typeof value === "object") {
      throw new RecipePostInitError({
        message: `postInit[${index}] (bun create): template references unknown answer "${name}".`,
        recipe: context.recipeId,
        actionIndex: index,
        actionType: "bun",
        actionVerb: "create",
        kind: "invalid-argv",
        remediation: `Declare a prompt named "${name}" (or pass --answer ${name}=<value>) before the bun create action runs.`,
      });
    }
    return String(value);
  });
  const trimmed = resolved.trim();
  if (trimmed === "" || trimmed.startsWith("-")) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun create): template "${resolved}" is invalid; it must not be empty or begin with "-".`,
      recipe: context.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "create",
      kind: "invalid-argv",
      remediation:
        "Ensure the `template:` value (after answer substitution) is a package or template name, not empty or a flag.",
    });
  }
  return resolved;
};
