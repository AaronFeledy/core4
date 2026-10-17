import type { SnapshotGcReport } from "@lando/sdk/services";
import { ByteSize } from "effect";

export const snapshotBytes = (bytes: number): string => ByteSize.format(ByteSize.bytes(bytes));

export const renderSnapshotGcReport = (report: SnapshotGcReport): string => {
  const unavailable = report.providers.filter((provider) => provider.status === "unavailable");
  const note =
    unavailable.length === 0
      ? ""
      : ` Skipped unavailable providers: ${unavailable.map((provider) => provider.provider).join(", ")}.`;
  if (report.totalCount === 0) return `No orphaned snapshots found.${note}`;
  if (report.prune)
    return `Removed ${report.removedCount} orphaned snapshots (${snapshotBytes(report.totalBytes)}).${note}`;
  return `${report.totalCount} orphaned snapshots (${snapshotBytes(report.totalBytes)}). Run lando snapshots:gc --prune to remove them.${note}`;
};
