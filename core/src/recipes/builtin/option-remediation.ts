import type { RecipeOptionType } from "@lando/sdk/schema";

/**
 * Phrase the remediation for a rejected recipe option from the descriptor the
 * snapshot publishes, so a boolean option is never told to match a choice list
 * and a patterned string is never told to pick from an enum. Descriptors carry
 * only declared, nonsecret option domains, so their bounds are safe to quote.
 */
export const recipeOptionRemediation = (descriptor: RecipeOptionType): string => {
  switch (descriptor.kind) {
    case "boolean":
      return "Supply true or false.";
    case "enum":
      return `Supply one of the declared choices: ${descriptor.values.join(", ")}.`;
    case "string":
      return descriptor.pattern === undefined
        ? "Supply a string within the option's declared length bounds."
        : `Supply a string matching ${descriptor.pattern}.`;
    case "number":
      return descriptor.integer === true
        ? "Supply an integer within the option's declared bounds."
        : "Supply a number within the option's declared bounds.";
    case "array":
      return "Supply an array whose length and items match the option's declared item shape.";
    case "optional":
      return `Omit the option or supply a matching value. ${recipeOptionRemediation(descriptor.inner)}`;
    default:
      return descriptor satisfies never;
  }
};
