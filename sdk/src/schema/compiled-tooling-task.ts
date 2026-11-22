import { Schema } from "effect";
import { DeprecationNotice } from "./deprecation.ts";
import { Environment } from "./environment-value.ts";
import { CommandSpec, PortablePath, ToolingVarLiteral } from "./primitives.ts";
import { ToolingArgShape, ToolingFlagShape } from "./tooling-input.ts";

// ==== Effective task data, after shorthand and environment normalization.

const target = {
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  user: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Environment),
};
const step = Schema.Struct({ ...target, cmd: Schema.String });
const variable = Schema.Union([
  ToolingVarLiteral,
  Schema.Struct({
    sh: Schema.String,
    service: target.service,
    env: target.env,
    sensitive: Schema.optionalKey(Schema.Literal(true)),
  }),
]);

export const CompiledToolingTask = Schema.Struct({
  ...target,
  disabled: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  cmd: Schema.optionalKey(CommandSpec),
  cmds: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, step]))),
  flags: Schema.optionalKey(Schema.Record(Schema.String, ToolingFlagShape)),
  args: Schema.optionalKey(Schema.Record(Schema.String, ToolingArgShape)),
  arguments: Schema.optionalKey(Schema.Literal(false)),
  wrapper: Schema.optionalKey(Schema.Boolean),
  vars: Schema.optionalKey(Schema.Record(Schema.String, variable)),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type CompiledToolingTask = typeof CompiledToolingTask.Type;
