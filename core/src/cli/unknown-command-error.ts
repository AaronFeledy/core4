import { Schema } from "effect";

import { escapeDiagnosticText } from "./diagnostic-text";

export class UnknownCommandError extends Schema.TaggedError<UnknownCommandError>()("UnknownCommandError", {
  message: Schema.String,
  commandToken: Schema.String,
  remediation: Schema.String,
}) {}

export const unknownCommandError = (commandToken: string): UnknownCommandError =>
  new UnknownCommandError({
    message: `Command ${escapeDiagnosticText(commandToken)} not found`,
    commandToken,
    remediation: "Run `lando --help` to list registered command tokens and canonical command ids.",
  });
