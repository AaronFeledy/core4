import { Schema } from "effect";

import { AppRef } from "../schema/networking.ts";
import { Timestamp } from "./_shared.ts";

const CliCommandValues = Schema.Record(Schema.String, Schema.Unknown);
const CliCommandArgv = Schema.Array(Schema.String).annotate({
  description: "Command arguments after canonical command resolution.",
});
const CliCommandArgs = CliCommandValues.annotate({
  description: "Parsed positional arguments keyed by their command-spec names.",
});
const CliCommandFlags = CliCommandValues.annotate({
  description: "Parsed flags keyed by their canonical command-spec names.",
});
const CliCommandInvocation = {
  commandId: Schema.String.annotate({
    description: "Canonical command id, independent of the alias used to invoke it.",
  }),
  argv: CliCommandArgv,
  args: CliCommandArgs,
  flags: CliCommandFlags,
  cwd: Schema.String.annotate({ description: "Working directory at command invocation." }),
  app: Schema.optional(AppRef).annotate({
    description: "Resolved application binding for the command, when applicable.",
  }),
  invocationId: Schema.String.annotate({
    description: "ULID unique to this command invocation (outer or nested).",
  }),
  parentInvocationId: Schema.optional(Schema.String).annotate({
    description: "ULID of the enclosing invocation; absent for the outer user/embedding-host invocation.",
  }),
  timestamp: Timestamp,
};
const CliCommandTerminal = {
  ...CliCommandInvocation,
  exitCode: Schema.Number.annotate({ description: "Process exit code attributed to the command." }),
  durationMs: Schema.Number.annotate({ description: "Command execution duration in milliseconds." }),
};

export const CliCommandInitEvent = Schema.Struct({
  _tag: Schema.TemplateLiteral(["cli-", Schema.String, "-init"]),
  ...CliCommandInvocation,
});
export type CliCommandInitEvent = typeof CliCommandInitEvent.Type;

export const CliCommandRunEvent = Schema.Struct({
  _tag: Schema.TemplateLiteral(["cli-", Schema.String, "-run"]),
  ...CliCommandTerminal,
});
export type CliCommandRunEvent = typeof CliCommandRunEvent.Type;

export const CliCommandErrorEvent = Schema.Struct({
  _tag: Schema.TemplateLiteral(["cli-", Schema.String, "-error"]),
  ...CliCommandTerminal,
  failureTag: Schema.String.annotate({
    description: "Tagged failure identity, or Defect/Interrupted for non-typed failures.",
  }),
  message: Schema.optional(Schema.String),
});
export type CliCommandErrorEvent = typeof CliCommandErrorEvent.Type;
