import { resolveServiceRef } from "@lando/landofile/tooling-input";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import type { ToolingInputValues, ToolingTaskShape } from "@lando/sdk/schema";
import { Effect } from "effect";

export const validateToolingTargets = Effect.fnUntraced(function* (
  task: ToolingTaskShape,
  values: ToolingInputValues,
  name: string,
) {
  const normalized = yield* Effect.fromResult(normalizeToolingTask(name, task));
  for (const step of normalized.steps)
    yield* Effect.fromResult(resolveServiceRef(step.service, values, normalized));
  for (const [key, variable] of Object.entries(task.vars ?? {})) {
    if (typeof variable !== "object") continue;
    const service = variable.service ?? task.service;
    const target = yield* Effect.fromResult(
      normalizeToolingTask(name, {
        cmd: "capture",
        ...(service === undefined ? {} : { service }),
        ...(task.flags === undefined ? {} : { flags: task.flags }),
        ...(task.args === undefined ? {} : { args: task.args }),
      }),
    );
    yield* Effect.fromResult(
      resolveServiceRef(target.service, values, {
        name,
        source: { path: `tooling.${name}.vars.${key}.service`, task: name },
      }),
    );
  }
});
