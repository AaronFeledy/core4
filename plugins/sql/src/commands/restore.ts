import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";
import { render } from "./recovery-hint.ts";

export const spec = {
  id: "db:restore",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Target database service." },
    "any-series": {
      type: "boolean",
      default: false,
      description:
        "Allow an unverified or different database series. Ownership and volume checks still apply.",
    },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
  },
  args: {
    snapshot: { type: "string", required: true, description: "Snapshot id or label to restore." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("restore", input)),
  render,
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
