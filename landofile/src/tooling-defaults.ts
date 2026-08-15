import type { ToolingDefaultsShape, ToolingTaskShape } from "@lando/sdk/schema";

type ToolingTaskMap = Readonly<Record<string, ToolingTaskShape>>;

/** Fold app-wide defaults beneath every tooling task without mutating either input. */
export const applyToolingDefaults = (
  tooling: ToolingTaskMap | undefined,
  defaults: ToolingDefaultsShape | undefined,
): ToolingTaskMap | undefined => {
  if (tooling === undefined || defaults === undefined) return tooling;

  return Object.fromEntries(
    Object.entries(tooling).map(([name, task]) => [
      name,
      {
        ...(defaults.service === undefined ? {} : { service: defaults.service }),
        ...(defaults.dir === undefined ? {} : { dir: defaults.dir }),
        ...task,
        ...(defaults.env === undefined && task.env === undefined
          ? {}
          : { env: { ...defaults.env, ...task.env } }),
        ...(defaults.vars === undefined && task.vars === undefined
          ? {}
          : { vars: { ...defaults.vars, ...task.vars } }),
      },
    ]),
  );
};
