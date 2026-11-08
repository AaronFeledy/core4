import { CommandInputValidationError } from "@lando/sdk/errors";
import { suggestionForUnknownKey } from "@lando/sdk/schema";

export const commandInputOptionError = (
  input: { readonly target: string; readonly kind: "flag" | "arg"; readonly field: string },
  value: unknown,
  options: readonly string[] | undefined,
): CommandInputValidationError | undefined => {
  if (options === undefined || (typeof value === "string" && options.includes(value))) return undefined;
  const suggestion = typeof value === "string" ? suggestionForUnknownKey(value, options) : undefined;
  return new CommandInputValidationError({
    ...input,
    reason: "option",
    message: `${input.target} does not accept that ${input.field}.`,
    remediation: `${suggestion === undefined ? "" : `${suggestion} `}${input.field} takes one of: ${options.join(", ")}.`,
  });
};
