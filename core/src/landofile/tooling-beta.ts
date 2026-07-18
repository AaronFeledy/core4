import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

export const BETA_REMEDIATION = "Remove the section; this surface is not supported yet.";

const BETA_TOOLING_TASK_KEYS: ReadonlyArray<{ key: string }> = [
  { key: "deps" },
  { key: "engine" },
  { key: "bootstrap" },
  { key: "dotenv" },
  { key: "env" },
  { key: "user" },
  { key: "dir" },
  { key: "appMount" },
  { key: "stdio" },
  { key: "interactive" },
  { key: "passThrough" },
  { key: "sources" },
  { key: "generates" },
  { key: "method" },
  { key: "status" },
  { key: "preconditions" },
  { key: "if" },
  { key: "run" },
  { key: "platforms" },
  { key: "prompt" },
  { key: "silent" },
  { key: "output" },
  { key: "failFast" },
  { key: "disabled" },
  { key: "aliases" },
  { key: "topLevelAlias" },
  { key: "namespace" },
  { key: "internal" },
  { key: "hostProxyAllowed" },
  { key: "examples" },
  { key: "usage" },
];

const BETA_STEP_OBJECT_KEYS = new Set(["task", "defer", "for", "cmd"]);
const BETA_VAR_KEYS = new Set(["raw"]);

interface ToolingBetaFinding {
  readonly task: string;
  readonly key: string;
  readonly description: string;
}

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
  const tooling = (parsed as Record<string, unknown>).tooling;
  if (tooling === null || typeof tooling !== "object" || Array.isArray(tooling)) return undefined;
  const toolingMap = tooling as Record<string, unknown>;

  for (const [taskName, taskValue] of Object.entries(toolingMap)) {
    if (taskValue === null || typeof taskValue !== "object" || Array.isArray(taskValue)) continue;
    const task = taskValue as Record<string, unknown>;

    for (const entry of BETA_TOOLING_TASK_KEYS) {
      if (Object.hasOwn(task, entry.key)) {
        return {
          task: taskName,
          key: entry.key,
          description: `Tooling task field "${entry.key}"`,
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
          for (const varKey of Object.keys(varValue as Record<string, unknown>)) {
            if (BETA_VAR_KEYS.has(varKey)) {
              return {
                task: taskName,
                key: `vars.${varName}.${varKey}`,
                description: `Unsafe "${varKey}:" interpolation in tooling var "${varName}"`,
              };
            }
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
      message: `${finding.description} in tooling task "${finding.task}" is not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: BETA_REMEDIATION,
    }),
  );
};
