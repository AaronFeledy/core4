import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:seed",
  summary: "Seed a fresh database from a dump or snapshot.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Target database service." },
    snapshot: { type: "string", description: "Snapshot ID to seed from." },
  },
  args: {
    file: { type: "string", required: false, description: "Dump file to seed from." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("seed", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
