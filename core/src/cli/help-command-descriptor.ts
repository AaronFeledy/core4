import { ToolingInputDeclaration } from "@lando/sdk/schema";
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
export const HelpCommandDescriptor = Schema.Union([
  Schema.Struct({
    ...fields,
    source: Schema.Literal("built-in"),
    input: Schema.optionalKey(HelpCommandInput),
  }),
  Schema.Struct({
    ...fields,
    source: Schema.Literal("tooling"),
    input: Schema.optionalKey(ToolingInputDeclaration),
  }),
  Schema.Struct({
    ...fields,
    source: Schema.Literal("plugin"),
    input: Schema.optionalKey(HelpCommandInput),
    plugin: Schema.String,
    provenance: Schema.optionalKey(Schema.Literals(["bundled", "system", "user", "app", "explicit"])),
    implementation: Schema.optionalKey(Schema.Literals(["discovered", "validated"])),
    loadError: Schema.optionalKey(PluginCommandDiagnostic),
  }),
]);
