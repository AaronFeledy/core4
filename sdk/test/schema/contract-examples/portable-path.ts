import { PortablePath } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "PortablePath",
  schema: PortablePath,
  accepted: [
    { name: "absolute posix path", input: "/app", expected: "/app" },
    { name: "relative path", input: "./src", expected: "./src" },
    { name: "nested path", input: "vendor/bin/php", expected: "vendor/bin/php" },
  ],
  rejected: [
    { name: "number", input: 1, expectedErrorFragment: "string" },
    { name: "boolean", input: true, expectedErrorFragment: "string" },
    { name: "object", input: { path: "/app" }, expectedErrorFragment: "string" },
  ],
} as const satisfies NamedContractTable;
