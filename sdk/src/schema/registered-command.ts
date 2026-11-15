import { Schema } from "effect";
import { ToolingCompileError } from "../errors/tooling.ts";
import { ToolingInputDeclaration } from "./tooling-input.ts";
import { ToolingRunSummary } from "./tooling-run-summary.ts";

// ==== Registered command availability
const identity = {
  id: Schema.String.annotate({ description: "Canonical command id." }),
  summary: Schema.String.annotate({ description: "Command summary for discovery." }),
  hidden: Schema.Boolean.annotate({ description: "Whether the command is internal." }),
};

const toolingDiagnostic = Schema.Struct({
  _tag: ToolingCompileError.fields._tag,
  tool: ToolingCompileError.fields.tool,
  source: ToolingCompileError.fields.source,
  message: ToolingCompileError.fields.message,
  remediation: ToolingCompileError.fields.remediation,
  issues: ToolingCompileError.fields.issues,
  omittedIssueCount: ToolingCompileError.fields.omittedIssueCount,
});

const commandDiagnostic = Schema.Struct({
  _tag: Schema.String.annotate({ description: "Script or plugin diagnostic tag." }),
  message: Schema.String.annotate({ description: "Human-readable command failure." }),
  remediation: Schema.optionalKey(Schema.String).annotate({ description: "Corrective action, when known." }),
});

export const RegisteredCommand = Schema.Union([
  Schema.Struct({
    ...identity,
    _tag: Schema.Literal("Ready").annotate({ description: "The command can be invoked." }),
    input: ToolingInputDeclaration.annotate({ description: "Authoritative command inputs." }),
    runs: Schema.optionalKey(ToolingRunSummary).annotate({ description: "Bounded execution summary." }),
  }),
  Schema.Struct({
    ...identity,
    _tag: Schema.Literal("Disabled").annotate({
      description: "The authored declaration disables the command.",
    }),
    source: Schema.Struct({
      path: Schema.String.annotate({ description: "Source file for the declaration." }),
      task: Schema.String.annotate({ description: "Task name within the source." }),
    }).annotate({ description: "Disabled declaration's source identity." }),
  }),
  Schema.Struct({
    ...identity,
    _tag: Schema.Literal("Unavailable").annotate({ description: "Compilation or discovery failed." }),
    diagnostic: Schema.Union([toolingDiagnostic, commandDiagnostic]).annotate({
      description: "Stored diagnostic; publication must reapply disclosure bounds with its final redactor.",
    }),
  }),
]).annotate({
  identifier: "RegisteredCommand",
  description: "A discovered command with availability independent of internal visibility.",
});
export type RegisteredCommand = typeof RegisteredCommand.Type;
