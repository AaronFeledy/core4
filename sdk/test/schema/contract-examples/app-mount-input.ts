import { AppMountInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "AppMountInput",
  schema: AppMountInput,
  accepted: [
    { name: "destination string", input: "/site", expected: { target: "/site" } },
    { name: "disabled string", input: "disabled", expected: { target: "disabled" } },
    { name: "false disables", input: false, expected: false },
    {
      name: "object options",
      input: { target: "/app", readOnly: true, excludes: ["vendor"], includes: ["vendor/keep"] },
      expected: { target: "/app", readOnly: true, excludes: ["vendor"], includes: ["vendor/keep"] },
    },
  ],
  rejected: [
    { name: "generic type key", input: { type: "bind", target: "/x" }, expectedErrorFragment: "type" },
    { name: "generic source key", input: { source: "/host", target: "/x" }, expectedErrorFragment: "source" },
    { name: "number", input: 1, expectedErrorFragment: "string" },
  ],
} as const satisfies NamedContractTable;
