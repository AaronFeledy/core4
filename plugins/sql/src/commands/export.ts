import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:export",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Source database service." },
    "compression-level": {
      type: "number",
      valueType: "integer",
      description:
        "Host compression level: gzip 0-9 or zstd 1-22, chosen by the .gz or .zst suffix, or by --compression with -.",
      parse: (input) => {
        const value = Number(input);
        if (!Number.isSafeInteger(value)) {
          throw new RangeError("--compression-level must be an integer");
        }
        return value;
      },
    },
    compression: {
      type: "string",
      options: ["gzip", "zstd"],
      description: "Compress a dump written to stdout (-). File exports use the .gz or .zst suffix instead.",
    },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
  },
  args: {
    file: {
      type: "string",
      description:
        "Destination dump file. SQLite: .sqlite, .sqlite3, .db, or .db3 selects a database copy; optional .gz or .zst compresses it.",
      stdio: "stdout",
    },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("export", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
