import { Schema } from "effect";
import { Environment } from "./environment-value.ts";
import { PortablePath, ToolingVarLiteral } from "./primitives.ts";

const forbidden = Schema.optionalKey(Schema.Never);
export const EventCommandInputValue = Schema.Union([
  ToolingVarLiteral,
  Schema.Array(Schema.String),
  Schema.Array(Schema.Number),
  Schema.Array(Schema.Boolean),
]);
export type EventCommandInputValue = typeof EventCommandInputValue.Type;

export const EventForSelector = Schema.Union([
  Schema.Array(ToolingVarLiteral),
  Schema.Struct({
    var: Schema.String.annotateKey({
      description: "Name of a tooling variable whose list value supplies the for-loop items.",
    }),
    matrix: forbidden,
    sources: forbidden,
    generates: forbidden,
  }),
  Schema.Struct({
    var: forbidden,
    matrix: Schema.Record(Schema.String, Schema.Array(ToolingVarLiteral)).annotateKey({
      description: "Named axes of literal values; the step runs once per Cartesian combination.",
    }),
    sources: forbidden,
    generates: forbidden,
  }),
  Schema.Struct({
    var: forbidden,
    matrix: forbidden,
    sources: Schema.Literal(true).annotateKey({
      description:
        "Select values from task sources. Unavailable on root Landofile event steps; use a literal, variable, or matrix selector there.",
    }),
    generates: forbidden,
  }),
  Schema.Struct({
    var: forbidden,
    matrix: forbidden,
    sources: forbidden,
    generates: Schema.Literal(true).annotateKey({
      description:
        "Select values from task generates. Unavailable on root Landofile event steps; use a literal, variable, or matrix selector there.",
    }),
  }),
]).annotate({
  identifier: "EventForSelector",
  description: "Literal or task-derived values selected for an event step loop.",
});
export type EventForSelector = typeof EventForSelector.Type;

const tail = {
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
  silent: Schema.optionalKey(Schema.Boolean),
};
const target = {
  ...tail,
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(Environment),
  user: Schema.optionalKey(Schema.String),
};
const cmd = { ...target, cmd: Schema.String, task: forbidden, command: forbidden };
const task = {
  ...tail,
  cmd: forbidden,
  task: Schema.String,
  command: forbidden,
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)),
};
const command = {
  ...tail,
  cmd: forbidden,
  task: forbidden,
  command: Schema.String,
  flags: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  args: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  raw: Schema.optionalKey(Schema.Array(Schema.String)),
};
const deferredCmd = { ...target, cmd: forbidden, task: forbidden, command: forbidden, defer: Schema.String };

export const CompiledEventStep = Schema.Union([
  Schema.String,
  Schema.Struct({ ...cmd, defer: forbidden, for: forbidden }),
  Schema.Struct({ ...task, defer: forbidden, for: forbidden }),
  Schema.Struct({ ...command, defer: forbidden, for: forbidden }),
  Schema.Struct({ ...deferredCmd, for: forbidden }),
  Schema.Struct({ ...cmd, defer: Schema.Literal(true), for: forbidden }),
  Schema.Struct({ ...task, defer: Schema.Literal(true), for: forbidden }),
  Schema.Struct({ ...command, defer: Schema.Literal(true), for: forbidden }),
  Schema.Struct({ ...cmd, defer: forbidden, for: EventForSelector }),
  Schema.Struct({ ...task, defer: forbidden, for: EventForSelector }),
  Schema.Struct({ ...command, defer: forbidden, for: EventForSelector }),
  Schema.Struct({ ...deferredCmd, for: EventForSelector }),
]).annotate({
  identifier: "CompiledEventStep",
  description: "Compiled event action with a canonical environment and unevaluated invocation-time inputs.",
});
export type CompiledEventStep = typeof CompiledEventStep.Type;

export const EventStepSource = Schema.Literals(["host", "project"]).annotate({
  identifier: "EventStepSource",
  description: "Where a compiled event step was authored: `config.yml hostEvents` or the app Landofile.",
});
export type EventStepSource = typeof EventStepSource.Type;

export const EventStepStatus = Schema.Literals(["active", "skipped", "deduped"]).annotate({
  identifier: "EventStepStatus",
  description:
    "Plan-time status of a compiled event step: runnable, skipped with a reason, or a host step dropped because the project authored the same step.",
});
export type EventStepStatus = typeof EventStepStatus.Type;

export const EventStepPlan = Schema.Struct({
  step: CompiledEventStep,
  source: EventStepSource.annotate({ description: "Host or project origin of this event step." }),
  sourceIndex: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Index of the step in its authored list, so errors can point at `events.<name>[i]` or `hostEvents.<name>[i]`.",
  }),
  status: EventStepStatus.annotate({ description: "Plan-time execution disposition of the step." }),
  skipReason: Schema.optionalKey(Schema.String).annotate({
    description: "Reason this step is skipped or deduplicated, when applicable.",
  }),
}).annotate({
  identifier: "EventStepPlan",
  title: "Event Step Plan",
  description: "One compiled lifecycle or tooling event step with its provenance and plan-time status.",
});
export type EventStepPlan = typeof EventStepPlan.Type;

export const EventsPlan = Schema.Record(Schema.String, Schema.Array(EventStepPlan)).annotate({
  identifier: "EventsPlan",
  title: "Events Plan",
  description:
    "Effective event steps keyed by event name: host steps first, then project steps, each in authored order. Compiled by the planner from the Landofile `events:` and `config.yml hostEvents`; never persisted in provider applied state because Landofile events are always resolved from the current Landofile.",
});
export type EventsPlan = typeof EventsPlan.Type;
