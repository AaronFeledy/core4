import type { ToolingTaskShape } from "@lando/sdk/schema";
import type { NodePackageManagerName } from "./node-package-manager.ts";

const managerCommands = {
  pnpm: ["pnpm", "pnpx"],
  yarn: ["yarn"],
  bun: [],
  npm: ["npm", "npx"],
} as const satisfies Record<NodePackageManagerName, readonly string[]>;

export const nodeManagerTooling = (service: string, manager: NodePackageManagerName = "npm") => {
  return Object.fromEntries(
    managerCommands[manager].map((command) => [
      command,
      {
        cmd: [command],
        description: `Run ${command} inside the ${service} service.`,
        wrapper: true,
      } satisfies ToolingTaskShape,
    ]),
  );
};
