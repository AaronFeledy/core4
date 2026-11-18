import type { ToolingTaskShape } from "@lando/sdk/schema";

export const nodeManagerTooling = (service: string, manager: string | undefined) => {
  const commands =
    manager === "pnpm"
      ? ["pnpm", "pnpx"]
      : manager === "yarn"
        ? ["yarn"]
        : manager === "bun"
          ? []
          : ["npm", "npx"];
  return Object.fromEntries(
    commands.map((command) => [
      command,
      {
        cmd: [command],
        description: `Run ${command} inside the ${service} service.`,
        wrapper: true,
      } satisfies ToolingTaskShape,
    ]),
  );
};
