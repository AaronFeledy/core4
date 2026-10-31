import { ToolingInputDeclaration } from "@lando/sdk/schema";
import { Schema } from "effect";
import { PluginCommandDiagnostic } from "./plugin-command-catalog";

const fields = {
  canonicalId: Schema.String,
  typeable: Schema.String,
  extras: Schema.Array(Schema.String),
  summary: Schema.String,
};
export const HelpCommandDescriptor = Schema.Union([
  Schema.Struct({ ...fields, source: Schema.Literal("built-in") }),
  Schema.Struct({
    ...fields,
    source: Schema.Literal("tooling"),
    input: Schema.optionalKey(ToolingInputDeclaration),
  }),
  Schema.Struct({
    ...fields,
    source: Schema.Literal("plugin"),
    plugin: Schema.String,
    loadError: Schema.optionalKey(PluginCommandDiagnostic),
  }),
]);
