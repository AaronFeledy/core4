import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:snapshots",
  summary: "List database snapshots and recovery points.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Database service to list." },
    "from-app": { type: "string", description: "Explicit source app id." },
    "from-path": { type: "string", description: "Explicit canonical source app root." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("snapshots", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
