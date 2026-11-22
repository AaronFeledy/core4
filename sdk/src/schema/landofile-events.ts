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

const EVENT_STEP_IF_DESCRIPTION =
  "Boolean or whole-value expression checked when the step runs at invocation time, not at Landofile load. Applies to lifecycle and tooling event steps.";

const EventStepCondition = Schema.Union([
  Schema.String.annotate({ description: EVENT_STEP_IF_DESCRIPTION }),
  Schema.Boolean.annotate({ description: EVENT_STEP_IF_DESCRIPTION }),
]).annotate({ description: EVENT_STEP_IF_DESCRIPTION });

const EventStepTail = {
  ignoreError: Schema.optionalKey(Schema.Boolean).annotateKey({
    description:
      "When true, a non-zero exit or step failure is ignored and the remaining steps still run. Boundary errors still fail the event.",
  }),
  if: Schema.optionalKey(EventStepCondition).annotateKey({ description: EVENT_STEP_IF_DESCRIPTION }),
  silent: Schema.optionalKey(Schema.Boolean).annotateKey({
    description:
      "When true, step output is not presented to the user; the step still runs and can still fail.",
  }),
};

const EventCmdFields = {
  service: Schema.optionalKey(Schema.String).annotateKey({
    description:
      "Service that runs this cmd step, or :host for the host Bun Shell. Omitted uses the app primary service.",
  }),
  dir: Schema.optionalKey(PortablePath).annotateKey({
    description: "Working directory for this cmd step inside the target service or on the host.",
  }),
  env: Schema.optionalKey(ToolingEnvironment),
  user: Schema.optionalKey(Schema.String).annotateKey({
    description: "User this cmd step runs as inside the target service.",
  }),
};

const EventCommandFields = {
  flags: executionSiteKey(
    Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
    "event-lando-command",
  ).annotateKey({
    description: "Named flags passed to the canonical Lando command for this step.",
  }),
  args: executionSiteKey(
    Schema.optionalKey(Schema.Record(Schema.String, EventCommandInputValue)),
    "event-lando-command",
  ).annotateKey({
    description: "Named positional arguments passed to the canonical Lando command for this step.",
  }),
  raw: executionSiteKey(Schema.optionalKey(Schema.Array(Schema.String)), "event-lando-command").annotateKey({
    description: "Extra argv tokens appended to the canonical Lando command for this step.",
  }),
};

const EventTaskFields = {
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)).annotateKey({
    description: "Literal variable overrides supplied to the tooling task for this step only.",
  }),
};

export const EventCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: executionSiteKey(Schema.String, "event-lando-command").annotateKey({
    description: "Canonical Lando command id or alias to run for this step.",
  }),
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
  task: executionSiteKey(Schema.String, "event-lando-command").annotateKey({
    description: "Name of the Landofile tooling task to run for this step.",
  }),
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
  cmd: executionSiteKey(Schema.String, "event-step").annotateKey({
    description: "Shell command to run in the target service or on the host.",
  }),
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
  defer: executionSiteKey(Schema.String, "event-step").annotateKey({
    description:
      "Shell command registered for LIFO finalization after the rest of this event's steps finish.",
  }),
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventDeferredCmdStep = Schema.Struct({
  cmd: executionSiteKey(Schema.String, "event-step").annotateKey({
    description: "Shell command run during LIFO finalization for this deferred cmd step.",
  }),
  task: Forbidden,
  command: Forbidden,
  defer: Schema.Literal(true).annotateKey({
    description: "When true, runs this cmd step during LIFO finalization instead of inline.",
  }),
  for: Forbidden,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventDeferredTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: executionSiteKey(Schema.String, "event-lando-command").annotateKey({
    description: "Tooling task run during LIFO finalization for this deferred task step.",
  }),
  command: Forbidden,
  defer: Schema.Literal(true).annotateKey({
    description: "When true, runs this task step during LIFO finalization instead of inline.",
  }),
  for: Forbidden,
  ...EventTaskFields,
  ...EventStepTail,
});

const EventDeferredCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: executionSiteKey(Schema.String, "event-lando-command").annotateKey({
    description: "Canonical Lando command run during LIFO finalization for this deferred command step.",
  }),
  defer: Schema.Literal(true).annotateKey({
    description: "When true, runs this command step during LIFO finalization instead of inline.",
  }),
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
  cmd: executionSiteKey(Schema.String, "event-step").annotateKey({
    description: "Shell command repeated once per selected for-loop value.",
  }),
  task: Forbidden,
  command: Forbidden,
  defer: Forbidden,
  for: EventForSelector,
  ...EventCmdFields,
  ...EventStepTail,
});

const EventForTaskStep = Schema.Struct({
  cmd: Forbidden,
  task: executionSiteKey(Schema.String, "event-lando-command").annotateKey({
    description: "Tooling task repeated once per selected for-loop value.",
  }),
  command: Forbidden,
  defer: Forbidden,
  for: EventForSelector,
  ...EventTaskFields,
  ...EventStepTail,
});

const EventForCommandStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: executionSiteKey(Schema.String, "event-lando-command").annotateKey({
    description: "Canonical Lando command repeated once per selected for-loop value.",
  }),
  defer: Forbidden,
  for: EventForSelector,
  ...EventCommandFields,
  ...EventStepTail,
});

const EventForDeferredCmdStep = Schema.Struct({
  cmd: Forbidden,
  task: Forbidden,
  command: Forbidden,
  defer: executionSiteKey(Schema.String, "event-step").annotateKey({
    description:
      "Shell command deferred for LIFO finalization and repeated once per selected for-loop value.",
  }),
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

const lifecycleEventSteps = (when: string) =>
  Schema.optionalKey(layerMerge(Schema.Array(EventStep), REPLACE)).annotateKey({
    description: `Ordered event steps run ${when}.`,
  });

export const LandofileEvents = Schema.StructWithRest(
  Schema.Struct({
    "pre-init": lifecycleEventSteps("before app init"),
    "post-init": lifecycleEventSteps("after app init"),
    "pre-start": lifecycleEventSteps("before app start"),
    "post-start": lifecycleEventSteps("after app start"),
    "pre-stop": lifecycleEventSteps("before app stop"),
    "post-stop": lifecycleEventSteps("after app stop"),
    "pre-restart": lifecycleEventSteps("before app restart"),
    "post-restart": lifecycleEventSteps("after app restart"),
    "pre-rebuild": lifecycleEventSteps("before app rebuild"),
    "post-rebuild": lifecycleEventSteps("after app rebuild"),
    "pre-destroy": lifecycleEventSteps("before app destroy"),
    "post-destroy": lifecycleEventSteps("after app destroy"),
  }),
  [Schema.Record(Schema.String, layerMerge(Schema.Array(EventStep), REPLACE))],
).annotate({
  identifier: "LandofileEvents",
  description: "Ordered tasks keyed by lifecycle or tooling event name, validated after tooling resolution.",
});
export type LandofileEvents = typeof LandofileEvents.Type;
