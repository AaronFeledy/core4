import { Schema } from "effect";

import { layerMerge } from "./layer-merge.ts";
import { PortablePath, ToolingEnvironment, ToolingVarLiteral } from "./primitives.ts";

const REPLACE = { kind: "replace" } as const;
const Forbidden = Schema.optionalKey(Schema.Never);

export const AppLifecycleEventName = Schema.Literals([
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
  "pre-destroy",
  "post-destroy",
]).annotate({ description: "App lifecycle point that runs an ordered Landofile event step list." });
export type AppLifecycleEventName = typeof AppLifecycleEventName.Type;

export const ToolingEventName = Schema.TemplateLiteral([Schema.Literals(["pre-", "post-"]), Schema.String]);
export type ToolingEventName = typeof ToolingEventName.Type;

export const LandofileEventName = Schema.Union([AppLifecycleEventName, ToolingEventName]);
export type LandofileEventName = typeof LandofileEventName.Type;

const EventStepCondition = Schema.Union([Schema.String, Schema.Boolean]);

/**
 * Scalar literal or homogeneous scalar array for a canonical `command:` flag/arg.
 * Arrays support `multiple` inputs; mixed types and objects fail closed.
 */
export const EventCommandInputValue = Schema.Union([
  ToolingVarLiteral,
  Schema.Array(Schema.String),
  Schema.Array(Schema.Number),
  Schema.Array(Schema.Boolean),
]);
export type EventCommandInputValue = typeof EventCommandInputValue.Type;

const EventStepTail = {
  ignoreError: Schema.optionalKey(Schema.Boolean),
  if: Schema.optionalKey(EventStepCondition),
  silent: Schema.optionalKey(Schema.Boolean),
};

const EventCmdFields = {
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String),
};

const EventCommandFields = {
  flags: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  args: Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
  raw: Schema.optionalKey(Schema.Array(Schema.String)),
};

const EventTaskFields = {
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)),
};

export const EventCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Schema.String,
  defer: Forbidden,
  for: Forbidden,
  ...EventCommandFields,
  ...EventStepTail,
}).annotate({
  identifier: "EventCommandStep",
  description: "Direct invocation of a canonical Lando command.",
});
export type EventCommandStep = typeof EventCommandStep.Type;

export const EventTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: Schema.String,
  command: Forbidden,
  defer: Forbidden,
  for: Forbidden,
  ...EventTaskFields,
  ...EventStepTail,
}).annotate({
  identifier: "EventTaskStep",
  description: "Invocation of an effective Landofile tooling task.",
});
export type EventTaskStep = typeof EventTaskStep.Type;

export const EventCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Forbidden,
  command: Forbidden,
  defer: Forbidden,
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
}).annotate({
  identifier: "EventCmdStep",
  description: "Provider tooling command with optional service targeting.",
});
export type EventCmdStep = typeof EventCmdStep.Type;

const EventForVarSelector = Schema.Struct({
  var: Schema.String,
  matrix: Schema.optionalKey(Schema.Never),
  sources: Schema.optionalKey(Schema.Never),
  generates: Schema.optionalKey(Schema.Never),
});

const EventForMatrixSelector = Schema.Struct({
  var: Schema.optionalKey(Schema.Never),
  matrix: Schema.Record(Schema.String, Schema.Array(ToolingVarLiteral)),
  sources: Schema.optionalKey(Schema.Never),
  generates: Schema.optionalKey(Schema.Never),
});

const EventForSourcesSelector = Schema.Struct({
  var: Schema.optionalKey(Schema.Never),
  matrix: Schema.optionalKey(Schema.Never),
  sources: Schema.Literal(true),
  generates: Schema.optionalKey(Schema.Never),
});

const EventForGeneratesSelector = Schema.Struct({
  var: Schema.optionalKey(Schema.Never),
  matrix: Schema.optionalKey(Schema.Never),
  sources: Schema.optionalKey(Schema.Never),
  generates: Schema.Literal(true),
});

export const EventForSelector = Schema.Union([
  Schema.Array(ToolingVarLiteral),
  EventForVarSelector,
  EventForMatrixSelector,
  EventForSourcesSelector,
  EventForGeneratesSelector,
]).annotate({
  identifier: "EventForSelector",
  description: "Literal or task-derived values selected for an event step loop.",
});
export type EventForSelector = typeof EventForSelector.Type;

const EventDeferredCmdShorthand = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Forbidden,
  defer: Schema.String,
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventDeferredCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Forbidden,
  command: Forbidden,
  defer: Schema.Literal(true),
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventDeferredTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: Schema.String,
  command: Forbidden,
  defer: Schema.Literal(true),
  for: Forbidden,
  ...EventTaskFields,
  ...EventStepTail,
});

const EventDeferredCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Schema.String,
  defer: Schema.Literal(true),
  for: Forbidden,
  ...EventCommandFields,
  ...EventStepTail,
});

export const EventDeferStep = Schema.Union([
  EventDeferredCmdShorthand,
  EventDeferredCmdStep,
  EventDeferredTaskStep,
  EventDeferredCommandStep,
]).annotate({
  identifier: "EventDeferStep",
  description: "An event action registered for LIFO finalization.",
});
export type EventDeferStep = typeof EventDeferStep.Type;

const EventForCmdStep = Schema.Struct({
  cmd: Schema.String,
  task: Forbidden,
  command: Forbidden,
  defer: Forbidden,
  for: EventForSelector,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventForTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: Schema.String,
  command: Forbidden,
  defer: Forbidden,
  for: EventForSelector,
  ...EventTaskFields,
  ...EventStepTail,
});

const EventForCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Schema.String,
  defer: Forbidden,
  for: EventForSelector,
  ...EventCommandFields,
  ...EventStepTail,
});

const EventForDeferredCmdStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Forbidden,
  defer: Schema.String,
  for: EventForSelector,
  ...EventCmdFields,
  ...EventStepTail,
});

export const EventForStep = Schema.Union([
  EventForCmdStep,
  EventForTaskStep,
  EventForCommandStep,
  EventForDeferredCmdStep,
]).annotate({
  identifier: "EventForStep",
  description: "An event action repeated for each selected value.",
});
export type EventForStep = typeof EventForStep.Type;

export const EventStep = Schema.Union([
  Schema.String,
  EventCmdStep,
  EventTaskStep,
  EventCommandStep,
  EventDeferStep,
  EventForStep,
]).annotate({
  identifier: "EventStep",
  description: "One ordered events-as-tasks step.",
});
export type EventStep = typeof EventStep.Type;

export const LandofileEvents = Schema.StructWithRest(
  Schema.Struct({
    "pre-init": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "post-init": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "pre-start": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "post-start": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "pre-stop": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "post-stop": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "pre-restart": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "post-restart": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "pre-rebuild": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "post-rebuild": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "pre-destroy": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
    "post-destroy": Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)),
  }),
  [Schema.Record(Schema.String, layerMerge(Schema.Array(EventStep), REPLACE))],
).annotate({
  identifier: "LandofileEvents",
  description: "Ordered tasks keyed by lifecycle or tooling event name, validated after tooling resolution.",
});
export type LandofileEvents = typeof LandofileEvents.Type;

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
  step: EventStep.annotate({ description: "Authored action to execute at this event site." }),
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
