import { CertsInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "CertsInput",
  schema: CertsInput,
  accepted: [
    { name: "generated leaf", input: true, expected: true },
    { name: "disabled leaf", input: false, expected: false },
    { name: "custom path", input: "./certs/web.crt", expected: "./certs/web.crt" },
    {
      name: "cert and key pair",
      input: { cert: "./certs/web.crt", key: "./certs/web.key" },
      expected: { cert: "./certs/web.crt", key: "./certs/web.key" },
    },
  ],
  rejected: [
    { name: "number", input: 42, expectedErrorFragment: "boolean" },
    { name: "certificate list", input: ["./certs/web.crt"], expectedErrorFragment: "boolean" },
    { name: "key without cert", input: { key: "./certs/web.key" }, expectedErrorFragment: "cert" },
  ],
} as const satisfies NamedContractTable;
