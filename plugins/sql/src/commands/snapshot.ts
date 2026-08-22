import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:snapshot",
  summary: "Create a named snapshot of a database service.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Source database service." },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
    label: { type: "string", description: "Optional snapshot label." },
  },
  resultSchema: DbCommandResultSchema,
  run: (input) => runDbCommand(dbInputFromCommand("snapshot", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
