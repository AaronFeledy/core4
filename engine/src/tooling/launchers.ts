import { type ToolingNormalizationSource, toolingCompileResult } from "@lando/landofile/tooling-normalize";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { Result } from "effect";
import { type LauncherServiceFacts, isLauncherMarker, lowerLauncher } from "../planner/launchers.ts";

const inspectToolingLauncher = (
  argv: readonly string[],
  target: { readonly name: string | undefined; readonly services: LauncherServiceFacts },
) => {
  const name = target.name;
  const facts =
    name !== undefined && name !== ":host" && Object.hasOwn(target.services, name)
      ? target.services[name]
      : undefined;
  const lowered = lowerLauncher(argv, { name, facts });
  return Result.isSuccess(lowered)
    ? Result.succeed(lowered.success)
    : Result.fail([{ ...lowered.failure, path: ["cmd"] }] as const);
};

export const staticToolingLauncher = (
  task: ToolingTaskShape,
  context: { readonly services: LauncherServiceFacts; readonly primary: string | undefined },
) => {
  if (task.disabled || task.cmd === undefined || typeof task.cmd === "string") return undefined;
  const marker = task.cmd[0];
  if (marker === undefined || !isLauncherMarker(marker)) return undefined;
  const name = task.service ?? context.primary;
  if (
    name !== undefined &&
    ((name.startsWith(":") && name !== ":host") || name.includes("{{") || name.includes("${"))
  )
    return undefined;
  return inspectToolingLauncher(task.cmd, { name, services: context.services });
};

export const compileToolingLauncher = (
  argv: readonly string[],
  target: Parameters<typeof inspectToolingLauncher>[1],
  task: { readonly name: string; readonly source: ToolingNormalizationSource },
) => toolingCompileResult(task.name, inspectToolingLauncher(argv, target), task.source);
