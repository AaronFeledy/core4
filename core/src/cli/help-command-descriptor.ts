import { ToolingCompileError } from "@lando/sdk/errors";
import { ToolingInputDeclaration, ToolingRunSummary } from "@lando/sdk/schema";
import { Schema } from "effect";
import { PluginCommandDiagnostic } from "./plugin-command-catalog";

const defaultValue = Schema.optionalKey(
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
).annotate({
  description: "Default value when declared.",
});

const inputItemFields = {
  name: Schema.String.annotate({ description: "Declared input name." }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "Help text for this input." }),
  options: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Allowed input values." }),
  required: Schema.Boolean.annotate({ description: "Whether the input must be supplied." }),
  multiple: Schema.Boolean.annotate({ description: "Whether the input accepts multiple values." }),
};

export const HelpCommandInput = Schema.Struct({
  flags: Schema.Array(
    Schema.Struct({
      ...inputItemFields,
      type: Schema.Literals(["boolean", "string", "integer", "number"]).annotate({
        description: "Flag value type.",
      }),
      default: defaultValue,
      char: Schema.optionalKey(Schema.String).annotate({
        description: "Single-character short flag spelling.",
      }),
      aliases: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Alternate long flag spellings.",
      }),
      sensitive: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Sensitivity marker shown in help when declared.",
      }),
    }),
  ).annotate({ description: "Command flags in declaration order, excluding universal global flags." }),
  args: Schema.Array(
    Schema.Struct({
      ...inputItemFields,
      default: defaultValue,
      stdio: Schema.optionalKey(Schema.Literals(["stdin", "stdout"])).annotate({
        description: "Payload stream selected by a bare dash argument.",
      }),
    }),
  ).annotate({ description: "Positional arguments in declaration order." }),
}).annotate({
  identifier: "HelpCommandInput",
  description: "Declared inputs for a built-in or plugin command help target.",
});
export type HelpCommandInput = typeof HelpCommandInput.Type;

const fields = {
  canonicalId: Schema.String,
  typeable: Schema.String,
  extras: Schema.Array(Schema.String),
  summary: Schema.String,
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

const builtInDescriptor = Schema.Struct({
  ...fields,
  source: Schema.Literal("built-in"),
  input: Schema.optionalKey(HelpCommandInput),
});

const toolingDescriptor = Schema.Struct({
  ...fields,
  source: Schema.Literal("tooling"),
  loadError: Schema.optionalKey(Schema.Union([toolingDiagnostic, PluginCommandDiagnostic])),
  input: Schema.optionalKey(ToolingInputDeclaration),
  runs: Schema.optionalKey(ToolingRunSummary).annotate({
    description: "Bounded summary of what this task runs.",
  }),
});

const pluginDescriptor = Schema.Struct({
  ...fields,
  source: Schema.Literal("plugin"),
  input: Schema.optionalKey(HelpCommandInput),
  plugin: Schema.String,
  provenance: Schema.optionalKey(Schema.Literals(["bundled", "system", "user", "app", "explicit"])),
  implementation: Schema.optionalKey(Schema.Literals(["discovered", "validated"])),
  loadError: Schema.optionalKey(PluginCommandDiagnostic),
});

/** One catalog row: what a command is and where it came from. Catalog rows carry no placement data. */
export const HelpCommandDescriptor = Schema.Union([builtInDescriptor, toolingDescriptor, pluginDescriptor]);

export const HelpLandoFlags = Schema.Struct({
  afterName: Schema.Literals(["until-separator", "command-tail", "none"]).annotate({
    description:
      "Where Lando still reads its own flags after the command name: until-separator (up to the first --), command-tail (up to the command's tail), or none (only before the name).",
  }),
  commandOwned: Schema.Array(Schema.String).annotate({
    description:
      "Lando flag spellings the command reads itself where Lando would otherwise read them; empty when afterName is none, because then every token after the name is the command's.",
  }),
}).annotate({
  identifier: "HelpLandoFlags",
  description: "Placement of Lando's own flags for one help target.",
});

/** A help target: the catalog row plus the required flag-placement field. */
export const HelpCommandTargetDescriptor = Schema.Union([
  Schema.Struct({ ...builtInDescriptor.fields, landoFlags: HelpLandoFlags }),
  Schema.Struct({ ...toolingDescriptor.fields, landoFlags: HelpLandoFlags }),
  Schema.Struct({ ...pluginDescriptor.fields, landoFlags: HelpLandoFlags }),
]);
