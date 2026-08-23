import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:reset",
  summary: "Reset a database service to an empty state.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Target database service." },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("reset", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
