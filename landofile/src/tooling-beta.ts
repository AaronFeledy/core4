import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

export const BETA_REMEDIATION = "Remove the section; this surface is not supported yet.";

const BETA_TOOLING_TASK_KEYS = [
  "deps",
  "engine",
  "bootstrap",
  "dotenv",
  "user",
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
  "disabled",
  "aliases",
  "topLevelAlias",
  "namespace",
  "internal",
  "hostProxyAllowed",
  "examples",
  "usage",
] as const;

const BETA_STEP_OBJECT_KEYS = new Set(["task", "command", "defer", "for", "cmd"]);

interface ToolingBetaFinding {
  readonly task: string;
  readonly key: string;
  readonly description: string;
  readonly event?: string;
}

const scanEventsForBeta = (parsed: Readonly<Record<string, unknown>>): ToolingBetaFinding | undefined => {
  const events = parsed.events;
  if (events === null || typeof events !== "object" || Array.isArray(events)) return undefined;

  for (const [event, steps] of Object.entries(events as Record<string, unknown>)) {
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
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

const scanToolingInputMetadataForBeta = (
  taskName: string,
  task: Readonly<Record<string, unknown>>,
  section: "flags" | "args",
): ToolingBetaFinding | undefined => {
  const metadata = task[section];
  if (
    metadata === undefined ||
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }

  for (const [name, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        task: taskName,
        key: `${section}.${name}`,
        description: `Tooling ${section} entry "${name}"`,
      };
    }

    const keys = Object.keys(value as Record<string, unknown>);
    const unsupportedKey = keys.find((key) => key !== "deprecated");
    if (unsupportedKey !== undefined) {
      return {
        task: taskName,
        key: `${section}.${name}.${unsupportedKey}`,
        description: `Tooling ${section} field "${unsupportedKey}"`,
      };
    }
    if (!Object.hasOwn(value, "deprecated")) {
      return {
        task: taskName,
        key: `${section}.${name}`,
        description: `Tooling ${section} entry "${name}" without deprecation metadata`,
      };
    }
  }

  return undefined;
};

export const scanToolingForBeta = (parsed: unknown): ToolingBetaFinding | undefined => {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const parsedRecord = parsed as Record<string, unknown>;
  const eventFinding = scanEventsForBeta(parsedRecord);
  if (eventFinding !== undefined) return eventFinding;
  const tooling = parsedRecord.tooling;
  if (tooling === null || typeof tooling !== "object" || Array.isArray(tooling)) return undefined;
  const toolingMap = tooling as Record<string, unknown>;

  for (const [taskName, taskValue] of Object.entries(toolingMap)) {
    if (taskValue === null || typeof taskValue !== "object" || Array.isArray(taskValue)) continue;
    const task = taskValue as Record<string, unknown>;

    for (const key of BETA_TOOLING_TASK_KEYS) {
      if (Object.hasOwn(task, key)) {
        return {
          task: taskName,
          key,
          description: `Tooling task field "${key}"`,
        };
      }
    }

    const unsupportedInputMetadata =
      scanToolingInputMetadataForBeta(taskName, task, "flags") ??
      scanToolingInputMetadataForBeta(taskName, task, "args");
    if (unsupportedInputMetadata !== undefined) return unsupportedInputMetadata;

    const cmds = task.cmds;
    if (Array.isArray(cmds)) {
      for (const step of cmds) {
        if (step !== null && typeof step === "object" && !Array.isArray(step)) {
          const stepObj = step as Record<string, unknown>;
          for (const stepKey of Object.keys(stepObj)) {
            if (BETA_STEP_OBJECT_KEYS.has(stepKey)) {
              return {
                task: taskName,
                key: `cmds[].${stepKey}`,
                description: `Step-object cmds entry "${stepKey}"`,
              };
            }
          }
        }
      }
    }

    const vars = task.vars;
    if (vars !== null && typeof vars === "object" && !Array.isArray(vars)) {
      for (const [varName, varValue] of Object.entries(vars as Record<string, unknown>)) {
        if (varValue !== null && typeof varValue === "object" && !Array.isArray(varValue)) {
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

export const rejectBetaToolingFeatures = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const finding = scanToolingForBeta(parsed);
  if (finding === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message:
        finding.event === undefined
          ? `${finding.description} in tooling task "${finding.task}" is not supported in Alpha Landofiles at ${filePath}.`
          : `${finding.description} in event "${finding.event}" is not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: BETA_REMEDIATION,
    }),
  );
};
