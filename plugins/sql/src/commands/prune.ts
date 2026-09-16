import { Effect } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const renderDbSnapshotPrune = (result: DbCommandResult): string => {
  const candidates = result.pruneCandidates ?? [];
  const pruned = result.prunedSnapshotIds ?? [];
  const heading = result.retentionApplied === true ? "Deleted snapshots" : "Retention preview";
  const ids = result.retentionApplied === true ? pruned : candidates;
  return `${heading} for ${result.service}: ${ids.length === 0 ? "none" : ids.join(", ")}`;
};

export const spec = {
  id: "db:snapshots:prune",
  summary: "Preview or apply database snapshot retention.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Database service to prune." },
    "from-app": { type: "string", description: "Explicit sibling source app id." },
    "from-path": { type: "string", description: "Explicit canonical source app root." },
    "keep-latest": {
      type: "number",
      valueType: "integer",
      default: 3,
      description: "Number of newest manual snapshots to retain.",
      parse: (input) => {
        const value = Number(input);
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new RangeError("--keep-latest must be a non-negative integer");
        }
        return value;
      },
    },
    preview: { type: "boolean", default: false, description: "Show deletions without removing snapshots." },
    yes: { type: "boolean", default: false, description: "Confirm snapshot deletion." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  run: (input) => runDbCommand(dbInputFromCommand("prune", input)),
  render: ({ result }) =>
    Renderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${renderDbSnapshotPrune(result)}\n`))),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
