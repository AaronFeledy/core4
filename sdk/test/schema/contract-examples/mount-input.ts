import { MountInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "MountInput",
  schema: MountInput,
  accepted: [
    { name: "short form", input: "./src:/app", expected: "./src:/app" },
    {
      name: "bind object",
      input: { type: "bind", source: "./src", target: "/app", readOnly: true },
      expected: { type: "bind", source: "./src", target: "/app", readOnly: true },
    },
    {
      name: "tmpfs object",
      input: { type: "tmpfs", target: "/tmp" },
      expected: { type: "tmpfs", target: "/tmp" },
    },
    {
      name: "bind with excludes",
      input: { target: "/app", excludes: ["node_modules"], includes: ["node_modules/.bin"] },
      expected: { target: "/app", excludes: ["node_modules"], includes: ["node_modules/.bin"] },
    },
  ],
  rejected: [
    {
      name: "missing target object",
      input: { type: "bind", source: "./src" },
      expectedErrorFragment: "target",
    },
    { name: "number", input: 1, expectedErrorFragment: "string" },
    { name: "boolean", input: false, expectedErrorFragment: "string" },
  ],
} as const satisfies NamedContractTable;
