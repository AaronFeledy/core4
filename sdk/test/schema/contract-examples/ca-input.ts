import { CaInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "CaInput",
  schema: CaInput,
  accepted: [
    { name: "path string", input: "./certs/corp-ca.pem", expected: "./certs/corp-ca.pem" },
    {
      name: "import reference",
      input: {
        _tag: "ImportRef",
        path: "./certs/corp-ca.pem",
        basename: "corp-ca.pem",
        checksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        layer: "canonical",
        value: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      },
    },
  ],
  rejected: [
    { name: "number", input: 1, expectedErrorFragment: "string" },
    { name: "boolean", input: true, expectedErrorFragment: "string" },
    { name: "empty object", input: {}, expectedErrorFragment: "_tag" },
  ],
} as const satisfies NamedContractTable;
