import { isPlainRecord } from "@lando/sdk/landofile";
import type { ToolingTaskShape } from "@lando/sdk/schema";

export const nodePackageManagerEvidence = (metadata: unknown): unknown =>
  isPlainRecord(metadata) && isPlainRecord(metadata.node) ? metadata.node.packageManager : undefined;

export const lowerNodeLocalTooling = (task: ToolingTaskShape, metadata: unknown): ToolingTaskShape => {
  if (task.disabled || !Array.isArray(task.cmd) || task.cmd[0] !== ":node-local") return task;
  const pin = nodePackageManagerEvidence(metadata);
  const name = isPlainRecord(pin) ? pin.name : undefined;
  const prefix =
    name === "pnpm"
      ? ["pnpm", "exec"]
      : name === "yarn"
        ? ["yarn", "run"]
        : name === "bun"
          ? ["bun", "run"]
          : ["npm", "exec", "--no", "--"];
  return { ...task, cmd: [...prefix, ...task.cmd.slice(1)] };
};
