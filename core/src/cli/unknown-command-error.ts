import { UnknownCommandError } from "@lando/sdk/errors";

import { escapeDiagnosticText } from "./diagnostic-text";

export const UNKNOWN_COMMAND_FALLBACK = "Run `lando help --all` to list commands.";

export interface UnknownCommandGuidance {
  readonly remediation?: string;
  readonly suggestions?: ReadonlyArray<string>;
}

export const unknownCommandError = (
  commandToken: string,
  guidance: UnknownCommandGuidance = {},
): UnknownCommandError =>
  new UnknownCommandError({
    message: `Unknown command "${escapeDiagnosticText(commandToken)}".`,
    commandToken,
    suggestions: [...(guidance.suggestions ?? [])],
    remediation: guidance.remediation ?? UNKNOWN_COMMAND_FALLBACK,
  });
