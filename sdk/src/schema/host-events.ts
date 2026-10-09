import { Result, Schema } from "effect";

import { type ValidationIssue, validationIssue, validationIssuesFromCause } from "./validation-issue.ts";

const forbidden = (description: string) => Schema.optionalKey(Schema.Never).annotate({ description });

export const LANDO_HOST_EVENT_ENV = "LANDO_HOST_EVENT";

export const HOST_EVENT_NAMES = [
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
] as const;
export type HostEventName = (typeof HOST_EVENT_NAMES)[number];

export const HostEventName = Schema.Literals(HOST_EVENT_NAMES).annotate({
  identifier: "HostEventName",
  description: "Lifecycle event that accepts host-wide config.yml hostEvents steps.",
});

export const HOST_EVENT_CONTAINER_FORBIDDEN_NAMES = ["pre-start", "post-stop", "post-destroy"] as const;
export type HostEventContainerForbiddenName = (typeof HOST_EVENT_CONTAINER_FORBIDDEN_NAMES)[number];

export const LIFECYCLE_COMMAND_IDS = [
  "app:start",
  "app:stop",
  "app:restart",
  "app:rebuild",
  "app:destroy",
  "apps:poweroff",
] as const;
export type LifecycleCommandId = (typeof LIFECYCLE_COMMAND_IDS)[number];

export const LifecycleCommandId = Schema.Literals(LIFECYCLE_COMMAND_IDS).annotate({
  identifier: "LifecycleCommandId",
  description: "Canonical app lifecycle command id that hostEvents command steps must not name.",
});

export const LIFECYCLE_COMMAND_ALIASES = {
  start: "app:start",
  stop: "app:stop",
  restart: "app:restart",
  rebuild: "app:rebuild",
  destroy: "app:destroy",
  poweroff: "apps:poweroff",
} as const satisfies Readonly<Record<string, LifecycleCommandId>>;

export const resolveLifecycleCommandId = (command: string): string => {
  const trimmed = command.trim();
  return LIFECYCLE_COMMAND_ALIASES[trimmed as keyof typeof LIFECYCLE_COMMAND_ALIASES] ?? trimmed;
};

export const isLifecycleCommandId = (command: string): boolean =>
  (LIFECYCLE_COMMAND_IDS as readonly string[]).includes(resolveLifecycleCommandId(command));

export const HostEventCmdStep = Schema.Struct({
  cmd: Schema.String.annotate({ description: "Host or service command to run." }),
  service: Schema.optionalKey(Schema.String).annotate({
    description: "Target service, or :host to run on the host. Omitted uses the app primary.",
  }),
  command: forbidden("Rejected. Use command: only on a command step."),
  task: forbidden("Rejected. Host events do not run named tooling tasks."),
  defer: forbidden("Rejected. Host events do not support deferred steps."),
  for: forbidden("Rejected. Host events do not support for-loops."),
  env: forbidden("Rejected. Host events do not accept env."),
  flags: forbidden("Rejected. Host events do not accept flags."),
  args: forbidden("Rejected. Host events do not accept args."),
  dir: forbidden("Rejected. Host events do not accept dir."),
  user: forbidden("Rejected. Host events do not accept user."),
}).annotate({
  identifier: "HostEventCmdStep",
  title: "Host Event Cmd Step",
  description: "v1 hostEvents cmd step: cmd plus an optional service. No env, flags, args, dir, or user.",
});
export type HostEventCmdStep = typeof HostEventCmdStep.Type;

export const HostEventCommandStep = Schema.Struct({
  command: Schema.String.annotate({ description: "Canonical Lando command id or alias." }),
  cmd: forbidden("Rejected. Use cmd: only on a cmd step."),
  task: forbidden("Rejected. Host events do not run named tooling tasks."),
  defer: forbidden("Rejected. Host events do not support deferred steps."),
  for: forbidden("Rejected. Host events do not support for-loops."),
  env: forbidden("Rejected. Host events do not accept env."),
  flags: forbidden("Rejected. Host events do not accept flags."),
  args: forbidden("Rejected. Host events do not accept args."),
  dir: forbidden("Rejected. Host events do not accept dir."),
  user: forbidden("Rejected. Host events do not accept user."),
  service: forbidden("Rejected. command: steps do not target a service."),
}).annotate({
  identifier: "HostEventCommandStep",
  title: "Host Event Command Step",
  description: "v1 hostEvents command step: command only. Flags, args, and raw are rejected.",
});
export type HostEventCommandStep = typeof HostEventCommandStep.Type;

export const HostEventStep = Schema.Union([Schema.String, HostEventCmdStep, HostEventCommandStep]).annotate({
  identifier: "HostEventStep",
  title: "Host Event Step",
  description: "v1 hostEvents step: a string, {cmd, service?}, or {command}.",
});
export type HostEventStep = typeof HostEventStep.Type;

const hostEventSteps = Schema.optionalKey(Schema.Array(HostEventStep));

export const HostEvents = Schema.Struct({
  "pre-start": hostEventSteps.annotate({ description: "Host-wide steps before every user-app start." }),
  "post-start": hostEventSteps.annotate({ description: "Host-wide steps after every user-app start." }),
  "pre-stop": hostEventSteps.annotate({ description: "Host-wide steps before every user-app stop." }),
  "post-stop": hostEventSteps.annotate({ description: "Host-wide steps after every user-app stop." }),
  "pre-restart": hostEventSteps.annotate({ description: "Host-wide steps before every user-app restart." }),
  "post-restart": hostEventSteps.annotate({ description: "Host-wide steps after every user-app restart." }),
  "pre-rebuild": hostEventSteps.annotate({ description: "Host-wide steps before every user-app rebuild." }),
  "post-rebuild": hostEventSteps.annotate({ description: "Host-wide steps after every user-app rebuild." }),
  "pre-destroy": hostEventSteps.annotate({ description: "Host-wide steps before every user-app destroy." }),
  "post-destroy": hostEventSteps.annotate({ description: "Host-wide steps after every user-app destroy." }),
}).annotate({
  identifier: "HostEvents",
  title: "Host Events",
  description:
    "Host-wide lifecycle steps from <userConfRoot>/config.yml. They run for every user app and never enter GlobalConfig.events or the global-app Landofile.",
});
export type HostEvents = typeof HostEvents.Type;

export const isHostEventContainerStep = (step: HostEventStep): boolean => {
  if (typeof step === "string") return true;
  if ("command" in step && step.command !== undefined) return false;
  return step.service !== ":host";
};

export const hostEventStepLocation = (event: string, index: number): string =>
  `config.yml hostEvents.${event}[${index}]`;

export const formatHostEventsIssueMessage = (issue: ValidationIssue): string => {
  const path = issue.path[0] === "hostEvents" ? issue.path.slice(1) : issue.path;
  const event = typeof path[0] === "string" ? path[0] : undefined;
  const index = typeof path[1] === "number" ? path[1] : undefined;
  const nestedKey = typeof path[1] === "string" ? path[1] : typeof path[2] === "string" ? path[2] : undefined;
  const key = nestedKey ?? (index === undefined ? event : undefined);
  const location =
    event === undefined
      ? "config.yml hostEvents"
      : index === undefined
        ? `config.yml hostEvents.${event}`
        : hostEventStepLocation(event, index);
  if (key === undefined) return `${location}: ${issue.message}`;
  return `${location} rejects "${key}": ${issue.message}`;
};

export const hostEventsConfigIssues = (value: unknown): ReadonlyArray<ValidationIssue> => {
  const decoded = Schema.decodeUnknownResult(HostEvents)(value, {
    onExcessProperty: "error",
    errors: "all",
  });
  if (Result.isFailure(decoded)) {
    return validationIssuesFromCause(decoded.failure, { fallback: "Invalid hostEvents." }).map((issue) =>
      validationIssue(
        issue.path[0] === "hostEvents" ? issue.path : ["hostEvents", ...issue.path],
        formatHostEventsIssueMessage(issue),
        issue.suggestion,
      ),
    );
  }
  return hostEventsSemanticIssues(decoded.success);
};

export const hostEventsSemanticIssues = (events: HostEvents): ReadonlyArray<ValidationIssue> => {
  const issues: ValidationIssue[] = [];
  for (const event of HOST_EVENT_CONTAINER_FORBIDDEN_NAMES) {
    const steps = events[event] ?? [];
    for (const [index, step] of steps.entries()) {
      if (!isHostEventContainerStep(step)) continue;
      issues.push(
        validationIssue(
          ["hostEvents", event, index],
          `${hostEventStepLocation(event, index)} cannot target a container. Use service: ":host".`,
        ),
      );
    }
  }
  for (const event of HOST_EVENT_NAMES) {
    const steps = events[event] ?? [];
    for (const [index, step] of steps.entries()) {
      if (typeof step === "string" || !("command" in step) || step.command === undefined) continue;
      const resolved = resolveLifecycleCommandId(step.command);
      if (!isLifecycleCommandId(resolved)) continue;
      issues.push(
        validationIssue(
          ["hostEvents", event, index],
          `${hostEventStepLocation(event, index)} cannot run lifecycle command ${resolved}.`,
        ),
      );
    }
  }
  return issues;
};
