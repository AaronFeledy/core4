import { ContainerUser } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "ContainerUser",
  schema: ContainerUser,
  accepted: [
    { name: "root", input: "root", expected: "root" },
    { name: "bare name", input: "www-data", expected: "www-data" },
    { name: "numeric uid", input: "1000", expected: "1000" },
    { name: "uid:gid", input: "1000:1000", expected: "1000:1000" },
    { name: "www-data user and group", input: "www-data:www-data", expected: "www-data:www-data" },
    { name: "user:group", input: "app:staff", expected: "app:staff" },
    { name: "dots dashes underscores", input: "build_user.v2-a", expected: "build_user.v2-a" },
  ],
  rejected: [
    { name: "empty user", input: "", expectedErrorFragment: "Expected a container user name or numeric id" },
    {
      name: "embedded whitespace",
      input: "root wheel",
      expectedErrorFragment: "Expected a container user name or numeric id",
    },
    {
      name: "leading hyphen",
      input: "-root",
      expectedErrorFragment: "Expected a container user name or numeric id",
    },
    {
      name: "shell metacharacter",
      input: "root;id",
      expectedErrorFragment: "Expected a container user name or numeric id",
    },
    {
      name: "path separator",
      input: "/root",
      expectedErrorFragment: "Expected a container user name or numeric id",
    },
    {
      name: "empty group",
      input: "root:",
      expectedErrorFragment: "Expected a container user name or numeric id",
    },
  ],
} as const satisfies NamedContractTable;
