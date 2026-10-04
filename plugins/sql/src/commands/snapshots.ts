import { ByteSize, Clock, DateTime, Effect } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

const formatSnapshotAge = (createdAtMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

export const renderDbSnapshots = (result: DbCommandResult, nowMs: number): string => {
  const snapshots = result.snapshots ?? [];
  if (snapshots.length === 0) return `No snapshots found for ${result.service}.`;
  return [
    `Snapshots for ${result.service}:`,
    ...snapshots.flatMap((snapshot) => {
      const metadata = snapshot.metadata;
      const ownership = [metadata?.ownerKey ?? "unproven", metadata?.repoGroupKey, metadata?.sourceRoot]
        .filter((value) => value !== undefined)
        .join(" | ");
      return [
        snapshot.id,
        `  size: ${ByteSize.format(ByteSize.bytes(snapshot.sizeBytes))}`,
        `  age: ${formatSnapshotAge(DateTime.toEpochMillis(snapshot.createdAt), nowMs)}`,
        `  version: ${metadata === undefined ? "unknown" : `${metadata.family} ${metadata.version}`}`,
        `  label: ${snapshot.label ?? "-"}`,
        `  recovery reason: ${metadata?.recoveryReason ?? "unknown"}`,
        `  ownership: ${ownership}`,
      ];
    }),
  ].join("\n");
};

const render: NonNullable<ExecutableCommandSpec<DbCommandResult>["render"]> = Effect.fnUntraced(function* ({
  result,
}) {
  const renderer = yield* Renderer;
  const nowMs = yield* Clock.currentTimeMillis;
  yield* renderer.output.stdout(`${renderDbSnapshots(result, nowMs)}\n`);
});

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
  render,
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
