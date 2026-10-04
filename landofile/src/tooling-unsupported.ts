import { Effect, Predicate } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

export const UNSUPPORTED_REMEDIATION = "Remove the section; this surface is not supported yet.";

const UNSUPPORTED_TOOLING_TASK_KEYS = [
  "deps",
  "engine",
  "bootstrap",
  "dotenv",
  "appMount",
  "stdio",
  "interactive",
  "passThrough",
  "sources",
  "generates",
  "method",
  "status",
  "preconditions",
  "if",
  "run",
  "platforms",
  "prompt",
  "silent",
  "output",
  "failFast",
  "aliases",
  "topLevelAlias",
  "namespace",
  "internal",
  "hostProxyAllowed",
  "examples",
  "usage",
] as const;

/** Keys allowed on a cmds[] object step once `cmd` is present. */
const SUPPORTED_STEP_OBJECT_KEYS = new Set(["cmd", "service", "dir", "user", "env"]);

/** Dedicated step forms that remain unimplemented (rejected even without `cmd`). */
const UNSUPPORTED_STEP_OBJECT_KEYS = new Set(["task", "command", "defer", "for"]);

const SUPPORTED_FLAG_KEYS = new Set([
  "alias",
  "choices",
  "boolean",
  "default",
  "required",
  "description",
  "deprecated",
]);

const SUPPORTED_ARG_KEYS = new Set(["choices", "default", "required", "order", "description", "deprecated"]);

interface ToolingUnsupportedFinding {
  readonly task: string;
  readonly key: string;
  readonly description: string;
  readonly event?: string;
}

const scanEventsForUnsupported = (
  parsed: Readonly<Record<string, unknown>>,
): ToolingUnsupportedFinding | undefined => {
  const events = parsed.events;
  if (!Predicate.isObject(events)) return undefined;

  for (const [event, steps] of Object.entries(events as Record<string, unknown>)) {
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!Predicate.isObject(step)) continue;
      const structuredStep = step as Record<string, unknown>;
      if (Object.hasOwn(structuredStep, "platforms")) {
        return {
          task: event,
          key: `events.${event}[].platforms`,
          description: 'Event step field "platforms"',
          event,
        };
      }
    }
  }
  return undefined;
};

const scanToolingInputMetadataForUnsupported = (
  taskName: string,
  task: Readonly<Record<string, unknown>>,
  section: "flags" | "args",
): ToolingUnsupportedFinding | undefined => {
  const metadata = task[section];
  if (metadata === undefined || !Predicate.isObject(metadata)) {
    return undefined;
  }

  const allowedKeys = section === "flags" ? SUPPORTED_FLAG_KEYS : SUPPORTED_ARG_KEYS;

  for (const [name, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (!Predicate.isObject(value)) {
      return {
        task: taskName,
        key: `${section}.${name}`,
        description: `Tooling ${section} entry "${name}"`,
      };
    }

    const keys = Object.keys(value as Record<string, unknown>);
    const unsupportedKey = keys.find((key) => !allowedKeys.has(key));
    if (unsupportedKey !== undefined) {
      return {
        task: taskName,
        key: `${section}.${name}.${unsupportedKey}`,
        description: `Tooling ${section} field "${unsupportedKey}"`,
      };
    }
  }

  return undefined;
};

const scanCmdsStepForUnsupported = (
  taskName: string,
  stepIndex: number,
  stepObj: Readonly<Record<string, unknown>>,
): ToolingUnsupportedFinding | undefined => {
  for (const stepKey of Object.keys(stepObj)) {
    if (UNSUPPORTED_STEP_OBJECT_KEYS.has(stepKey) || !SUPPORTED_STEP_OBJECT_KEYS.has(stepKey)) {
      return {
        task: taskName,
        key: `cmds[${stepIndex}].${stepKey}`,
        description: `Step-object cmds entry "${stepKey}"`,
      };
    }
  }

  if (!Object.hasOwn(stepObj, "cmd")) {
    return {
      task: taskName,
      key: `cmds[${stepIndex}]`,
      description: `Step-object cmds entry at index ${stepIndex} without "cmd"`,
    };
  }

  return undefined;
};

export const scanToolingForUnsupported = (parsed: unknown): ToolingUnsupportedFinding | undefined => {
  if (!Predicate.isObjectOrArray(parsed)) return undefined;
  const parsedRecord = parsed as Record<string, unknown>;
  const eventFinding = scanEventsForUnsupported(parsedRecord);
  if (eventFinding !== undefined) return eventFinding;
  const tooling = parsedRecord.tooling;
  if (!Predicate.isObject(tooling)) return undefined;
  const toolingMap = tooling as Record<string, unknown>;

  for (const [taskName, taskValue] of Object.entries(toolingMap)) {
    if (!Predicate.isObject(taskValue)) continue;
    const task = taskValue as Record<string, unknown>;

    for (const key of UNSUPPORTED_TOOLING_TASK_KEYS) {
      if (Object.hasOwn(task, key)) {
        return {
          task: taskName,
          key,
          description: `Tooling task field "${key}"`,
        };
      }
    }

    const unsupportedInputMetadata =
      scanToolingInputMetadataForUnsupported(taskName, task, "flags") ??
      scanToolingInputMetadataForUnsupported(taskName, task, "args");
    if (unsupportedInputMetadata !== undefined) return unsupportedInputMetadata;

    const cmds = task.cmds;
    if (Array.isArray(cmds)) {
      for (let stepIndex = 0; stepIndex < cmds.length; stepIndex++) {
        const step = cmds[stepIndex];
        if (Predicate.isObject(step)) {
          const stepFinding = scanCmdsStepForUnsupported(
            taskName,
            stepIndex,
            step as Record<string, unknown>,
          );
          if (stepFinding !== undefined) return stepFinding;
        }
      }
    }

    const vars = task.vars;
    if (Predicate.isObject(vars)) {
      for (const [varName, varValue] of Object.entries(vars as Record<string, unknown>)) {
        if (Predicate.isObject(varValue)) {
          if (Object.hasOwn(varValue, "raw")) {
            return {
              task: taskName,
              key: `vars.${varName}.raw`,
              description: `Unsafe "raw:" interpolation in tooling var "${varName}"`,
            };
          }
        }
      }
    }
  }

  return undefined;
};

export const rejectUnsupportedToolingFeatures = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const finding = scanToolingForUnsupported(parsed);
  if (finding === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message:
        finding.event === undefined
          ? `${finding.description} in tooling task "${finding.task}" is not supported at ${filePath}.`
          : `${finding.description} in event "${finding.event}" is not supported at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    }),
  );
};
