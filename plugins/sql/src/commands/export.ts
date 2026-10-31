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
      description: "Host dump compression level: gzip 0-9 or zstd 1-22, selected by the file suffix.",
      parse: (input) => {
        const value = Number(input);
        if (!Number.isSafeInteger(value)) {
          throw new RangeError("--compression-level must be an integer");
        }
        return value;
      },
    },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
  },
  args: {
    file: { type: "string", description: "Destination dump file." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("export", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
