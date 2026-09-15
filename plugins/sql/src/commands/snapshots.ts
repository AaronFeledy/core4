import { DateTime, Effect } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";

import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

const formatSnapshotSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  if (sizeBytes < 1024 ** 3) return `${(sizeBytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(sizeBytes / 1024 ** 3).toFixed(1)} GiB`;
};

const formatSnapshotAge = (createdAtMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

export const renderDbSnapshots = (result: DbCommandResult, nowMs = Date.now()): string => {
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
        `  size: ${formatSnapshotSize(snapshot.sizeBytes)}`,
        `  age: ${formatSnapshotAge(Date.parse(DateTime.formatIso(snapshot.createdAt)), nowMs)}`,
        `  version: ${metadata === undefined ? "unknown" : `${metadata.family} ${metadata.version}`}`,
        `  label: ${snapshot.label ?? "-"}`,
        `  recovery reason: ${metadata?.recoveryReason ?? "unknown"}`,
        `  ownership: ${ownership}`,
      ];
    }),
  ].join("\n");
};

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
  render: ({ result }) =>
    Renderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${renderDbSnapshots(result)}\n`))),
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
