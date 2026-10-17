import type { SnapshotGcReport } from "@lando/sdk/services";
import { ByteSize } from "effect";

export const snapshotBytes = (bytes: number): string => ByteSize.format(ByteSize.bytes(bytes));

const providerNotes = (report: SnapshotGcReport): string => {
  const named = (status: "unavailable" | "failed") =>
    report.providers.filter((provider) => provider.status === status).map((provider) => provider.provider);
  const unavailable = named("unavailable");
  const failed = report.providers.filter((provider) => provider.status === "failed");
  return [
    ...(unavailable.length === 0 ? [] : [` Skipped unavailable providers: ${unavailable.join(", ")}.`]),
    ...failed.map(
      (provider) => ` Could not check ${provider.provider}: ${provider.error ?? "unknown error"}.`,
    ),
  ].join("");
};

export const renderSnapshotGcReport = (report: SnapshotGcReport): string => {
  const notes = providerNotes(report);
  if (report.totalCount === 0) return `No orphaned snapshots found.${notes}`;
  if (report.prune)
    return `Removed ${report.removedCount} orphaned snapshots (${snapshotBytes(report.totalBytes)}).${notes}`;
  return `${report.totalCount} orphaned snapshots (${snapshotBytes(report.totalBytes)}). Run lando snapshots:gc --prune to remove them.${notes}`;
};
