import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:export",
  summary: "Export a database dump from a service.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Source database service." },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
  },
  args: {
    file: { type: "string", description: "Destination dump file." },
  },
  resultSchema: DbCommandResultSchema,
  run: (input) => runDbCommand(dbInputFromCommand("export", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
