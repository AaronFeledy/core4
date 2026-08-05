import { Schema } from "effect";

export class UnknownCommandError extends Schema.TaggedError<UnknownCommandError>()("UnknownCommandError", {
  message: Schema.String,
  commandToken: Schema.String,
  remediation: Schema.String,
}) {}

export const unknownCommandError = (commandToken: string): UnknownCommandError =>
  new UnknownCommandError({
    message: `Command ${commandToken} not found`,
    commandToken,
    remediation: "Run `lando --help` to list registered command tokens and canonical command ids.",
  });
