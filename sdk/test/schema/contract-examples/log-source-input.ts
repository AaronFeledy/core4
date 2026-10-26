import { LogSourceInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "LogSourceInput",
  schema: LogSourceInput,
  accepted: [
    {
      name: "path defaults id stream strategy",
      input: { path: "/var/log/apache2/error.log" },
      expected: {
        id: "error.log",
        path: "/var/log/apache2/error.log",
        stream: "stderr",
        strategy: "follow",
        required: false,
        timestamps: false,
      },
    },
    {
      name: "explicit id label stream",
      input: {
        id: "app",
        label: "Application log",
        path: "/var/www/app/storage/logs/app.log",
        stream: "stdout",
      },
      expected: {
        id: "app",
        label: "Application log",
        path: "/var/www/app/storage/logs/app.log",
        stream: "stdout",
        strategy: "follow",
        required: false,
        timestamps: false,
      },
    },
  ],
  rejected: [
    {
      name: "path basename console reserved",
      input: { path: "/var/log/console" },
      expectedErrorFragment: "console",
    },
    { name: "missing path", input: { id: "app" }, expectedErrorFragment: "path" },
    {
      name: "explicit console id",
      input: { path: "/var/log/app.log", id: "console" },
      expectedErrorFragment: "console",
    },
  ],
} as const satisfies NamedContractTable;
