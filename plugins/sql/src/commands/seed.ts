import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:seed",
  summary: "Seed a fresh database from a dump, snapshot, or running app.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Target database service." },
    snapshot: { type: "string", description: "Snapshot id or label to seed from." },
    "from-app": { type: "string", description: "Running app to copy the database from." },
    "from-path": { type: "string", description: "Checkout of a running app to copy the database from." },
    "from-service": { type: "string", description: "Database service in the source app." },
  },
  args: {
    file: { type: "string", required: false, description: "Dump file to seed from." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("seed", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
