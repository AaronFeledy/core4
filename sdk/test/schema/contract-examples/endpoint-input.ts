import { EndpointInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "EndpointInput",
  schema: EndpointInput,
  accepted: [
    {
      name: "shorthand http",
      input: "http:8080",
      expected: { _tag: "internal", protocol: "http", port: 8080 },
    },
    {
      name: "named shorthand",
      input: "ui=https:443",
      expected: { _tag: "internal", protocol: "https", port: 443, name: "ui" },
    },
    {
      name: "internal http object",
      input: { kind: "internal", protocol: "http", port: 8080 },
      expected: { _tag: "internal", protocol: "http", port: 8080 },
    },
    {
      name: "internal unix",
      input: { kind: "internal", protocol: "unix", socketPath: "/run/app.sock" },
      expected: { _tag: "internal", protocol: "unix", socketPath: "/run/app.sock" },
    },
    {
      name: "published with empty publication",
      input: { kind: "published", protocol: "http", port: 8080, publication: {} },
      expected: { _tag: "published", protocol: "http", port: 8080, publication: {} },
    },
    {
      name: "published tcp with host port",
      input: {
        kind: "published",
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
    {
      name: "missing kind",
      input: { protocol: "http", port: 8080 },
      expectedErrorFragment: "kind: internal or kind: published",
    },
    {
      name: "legacy tag only",
      input: { _tag: "internal", protocol: "http", port: 8080 },
      expectedErrorFragment: "kind: internal or kind: published",
    },
    {
      name: "invalid protocol",
      input: { kind: "internal", protocol: "smtp", port: 25 },
      expectedErrorFragment: "protocol",
    },
    {
      name: "port out of range",
      input: { kind: "internal", protocol: "http", port: 0 },
      expectedErrorFragment: "between",
    },
    {
      name: "invalid shorthand",
      input: "http:0",
      expectedErrorFragment: "protocol:port",
    },
  ],
} as const satisfies NamedContractTable;
