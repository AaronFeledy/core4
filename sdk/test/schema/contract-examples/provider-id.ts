import { ProviderId } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "ProviderId",
  schema: ProviderId,
  accepted: [
    { name: "lando provider", input: "lando", expected: "lando" },
    { name: "docker provider", input: "docker", expected: "docker" },
    { name: "podman provider", input: "podman", expected: "podman" },
  ],
  rejected: [
    { name: "number", input: 0, expectedErrorFragment: "string" },
    { name: "null", input: null, expectedErrorFragment: "string" },
    { name: "array", input: ["lando"], expectedErrorFragment: "string" },
  ],
} as const satisfies NamedContractTable;
