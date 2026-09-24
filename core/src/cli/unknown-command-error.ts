import { Schema } from "effect";

import { escapeDiagnosticText } from "./diagnostic-text";

export class UnknownCommandError extends Schema.TaggedError<UnknownCommandError>()("UnknownCommandError", {
  message: Schema.String,
  commandToken: Schema.String,
  remediation: Schema.String,
}) {}

export const unknownCommandError = (commandToken: string, suggestedCommandId?: string): UnknownCommandError =>
  new UnknownCommandError({
    message: `Command ${escapeDiagnosticText(commandToken)} not found`,
    commandToken,
    remediation:
      suggestedCommandId === undefined
        ? "Run `lando help --all` to list commands."
        : `Run \`lando ${escapeDiagnosticText(suggestedCommandId)}\` instead.`,
  });
