import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:import",
  summary: "Import a database dump into a service.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Target database service." },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
  },
  args: {
    file: { type: "string", required: true, description: "Dump file to import." },
  },
  resultSchema: DbCommandResultSchema,
  run: (input) => runDbCommand(dbInputFromCommand("import", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
