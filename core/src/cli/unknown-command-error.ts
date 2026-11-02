import { Schema } from "effect";

import { escapeDiagnosticText } from "./diagnostic-text";

export class UnknownCommandError extends Schema.TaggedError<UnknownCommandError>()("UnknownCommandError", {
  message: Schema.String,
  commandToken: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export const unknownCommandError = (commandToken: string, remediation?: string): UnknownCommandError =>
  new UnknownCommandError({
    message: `Command ${escapeDiagnosticText(commandToken)} not found`,
    commandToken,
    remediation: remediation ?? "Run `lando help --all` to list commands.",
  });
