import { StorageInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "StorageInput",
  schema: StorageInput,
  accepted: [
    { name: "short target path", input: "/data", expected: "/data" },
    {
      name: "store object",
      input: { store: "uploads", target: "/app/uploads" },
      expected: { store: "uploads", target: "/app/uploads" },
    },
    {
      name: "cache kind with key",
      input: { store: "cache", target: "/app/.cache", kind: "cache", key: "npm", readOnly: false },
      expected: {
        store: "cache",
        target: "/app/.cache",
        kind: "cache",
        key: "npm",
        readOnly: false,
      },
    },
    {
      name: "scoped store",
      input: { store: "db", target: "/var/lib/mysql", scope: "app" },
      expected: { store: "db", target: "/var/lib/mysql", scope: "app" },
    },
  ],
  rejected: [
    { name: "missing target", input: { store: "uploads" }, expectedErrorFragment: "target" },
    { name: "missing store", input: { target: "/data" }, expectedErrorFragment: "store" },
    { name: "number", input: 3, expectedErrorFragment: "string" },
  ],
} as const satisfies NamedContractTable;
