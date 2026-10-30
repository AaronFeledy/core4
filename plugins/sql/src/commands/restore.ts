import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:restore",
  summary: "Restore a database service from a snapshot.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Target database service." },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
    force: {
      type: "boolean",
      default: false,
      description: "Replace a SQLite file while the owning service is running.",
    },
  },
  args: {
    snapshot: { type: "string", required: true, description: "Snapshot id or label to restore." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("restore", input)),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
