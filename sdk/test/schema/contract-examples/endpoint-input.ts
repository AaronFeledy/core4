import { EndpointInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "EndpointInput",
  schema: EndpointInput,
  accepted: [
    {
      name: "internal http",
      input: { _tag: "internal", protocol: "http", port: 8080 },
      expected: { _tag: "internal", protocol: "http", port: 8080 },
    },
    {
      name: "internal unix",
      input: { _tag: "internal", protocol: "unix", socketPath: "/run/app.sock" },
      expected: { _tag: "internal", protocol: "unix", socketPath: "/run/app.sock" },
    },
    {
      name: "published with empty publication",
      input: { _tag: "published", protocol: "http", port: 8080, publication: {} },
      expected: { _tag: "published", protocol: "http", port: 8080, publication: {} },
    },
    {
      name: "published tcp with host port",
      input: {
        _tag: "published",
        protocol: "tcp",
        port: 53,
        publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
      },
      expected: {
        _tag: "published",
        protocol: "tcp",
        port: 53,
        publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
      },
    },
  ],
  rejected: [
    { name: "missing tag", input: { protocol: "http", port: 8080 }, expectedErrorFragment: "_tag" },
    {
      name: "invalid protocol",
      input: { _tag: "internal", protocol: "smtp", port: 25 },
      expectedErrorFragment: "protocol",
    },
    {
      name: "port out of range",
      input: { _tag: "internal", protocol: "http", port: 0 },
      expectedErrorFragment: "between",
    },
  ],
} as const satisfies NamedContractTable;
