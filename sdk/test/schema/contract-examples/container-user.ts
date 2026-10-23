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
    { name: "empty user", input: "", expectedErrorFragment: "matching the RegExp" },
    { name: "embedded whitespace", input: "root wheel", expectedErrorFragment: "matching the RegExp" },
    { name: "leading hyphen", input: "-root", expectedErrorFragment: "matching the RegExp" },
    { name: "shell metacharacter", input: "root;id", expectedErrorFragment: "matching the RegExp" },
    { name: "path separator", input: "/root", expectedErrorFragment: "matching the RegExp" },
    { name: "empty group", input: "root:", expectedErrorFragment: "matching the RegExp" },
  ],
} as const satisfies NamedContractTable;
