import { CommandSpec } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "CommandSpec",
  schema: CommandSpec,
  accepted: [
    { name: "shell string", input: "npm start", expected: "npm start" },
    { name: "argv array", input: ["npm", "start"], expected: ["npm", "start"] },
    { name: "empty argv", input: [], expected: [] },
    { name: "empty string", input: "", expected: "" },
  ],
  rejected: [
    { name: "number", input: 1, expectedErrorFragment: "string" },
    { name: "boolean", input: true, expectedErrorFragment: "string" },
    { name: "object", input: { cmd: "npm start" }, expectedErrorFragment: "string" },
  ],
} as const satisfies NamedContractTable;
