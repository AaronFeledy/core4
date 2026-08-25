import { styleFrame } from "./task-tree-render.ts";

const PROVISIONAL_STARTUP_COMMANDS = ["app:start", "app:restart", "app:rebuild"] as const;

export const isProvisionalStartupCommand = (commandId: string): boolean =>
  PROVISIONAL_STARTUP_COMMANDS.some((id) => id === commandId);

export const provisionalDisplayLabel = (commandId: string): string => {
  const separator = commandId.lastIndexOf(":");
  return separator === -1 ? commandId : commandId.slice(separator + 1);
};

export const provisionalTitleFrame = (commandId: string): ReadonlyArray<string> =>
  styleFrame([`╭─ ${provisionalDisplayLabel(commandId)}`]);
