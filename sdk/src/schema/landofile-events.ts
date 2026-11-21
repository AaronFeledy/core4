import { Schema } from "effect";
import { ToolingEnvironment } from "./environment-input.ts";
import { EventCommandInputValue, EventForSelector } from "./event-plan.ts";
import { executionSite, executionSiteKey } from "./execution-site.ts";
import { layerMerge } from "./layer-merge.ts";
import { PortablePath, ToolingVarLiteral } from "./primitives.ts";

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
  flags: executionSiteKey(
    Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
    "event-lando-command",
  ),
  args: executionSiteKey(
    Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
    "event-lando-command",
  ),
  raw: executionSiteKey(Schema.optionalKey(Schema.Array(Schema.String)), "event-lando-command"),
};

const EventTaskFields = {
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)),
};

export const EventCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: executionSiteKey(Schema.String, "event-lando-command"),
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
  task: executionSiteKey(Schema.String, "event-lando-command"),
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
  cmd: executionSiteKey(Schema.String, "event-step"),
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

const EventDeferredCmdShorthand = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Forbidden,
  defer: executionSiteKey(Schema.String, "event-step"),
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventDeferredCmdStep = Schema.Struct({
  cmd: executionSiteKey(Schema.String, "event-step"),
  task: Forbidden,
  command: Forbidden,
  defer: Schema.Literal(true),
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventDeferredTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: executionSiteKey(Schema.String, "event-lando-command"),
  command: Forbidden,
  defer: Schema.Literal(true),
  for: Forbidden,
  ...EventTaskFields,
  ...EventStepTail,
});

const EventDeferredCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: executionSiteKey(Schema.String, "event-lando-command"),
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
  cmd: executionSiteKey(Schema.String, "event-step"),
  task: Forbidden,
  command: Forbidden,
  defer: Forbidden,
  for: EventForSelector,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventForTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: executionSiteKey(Schema.String, "event-lando-command"),
  command: Forbidden,
  defer: Forbidden,
  for: EventForSelector,
  ...EventTaskFields,
  ...EventStepTail,
});

const EventForCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: executionSiteKey(Schema.String, "event-lando-command"),
  defer: Forbidden,
  for: EventForSelector,
  ...EventCommandFields,
  ...EventStepTail,
});

const EventForDeferredCmdStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Forbidden,
  defer: executionSiteKey(Schema.String, "event-step"),
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
  executionSite(Schema.String, "event-step"),
  EventCmdStep,
  EventTaskStep,
  EventCommandStep,
  EventDeferStep,
  EventForStep,
])
  .annotate({
    identifier: "EventStep",
    description: "One ordered events-as-tasks step.",
    message: "Expected a command string or a step with exactly one of cmd, task, command, defer, or for",
  })
  .pipe(Schema.annotateEncoded({ landoAuthoredInput: "EventStep" }));
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
