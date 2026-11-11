import type { SourceGcReport } from "@lando/engine/operations/source-cache-gc";
import { ByteSize } from "effect";

const sourceBytes = (bytes: number): string => ByteSize.format(ByteSize.bytes(bytes));

const incompleteNote = (report: SourceGcReport): string => {
  if (report.reachability === "complete") return "";
  const bad = report.roots.filter((root) => root.status === "unreadable" || root.status === "corrupt");
  if (bad.length === 0) return " Reachability is incomplete.";
  const names = bad.map((root) => root.lockfile).join(", ");
  return ` Reachability is incomplete (unreadable/corrupt lockfiles: ${names}).`;
};

export const renderSourceGcReport = (report: SourceGcReport): string => {
  const notes = incompleteNote(report);
  const { totals } = report;
  if (totals.entries === 0 && totals.eligible === 0) {
    return `No source-cache entries found.${notes}`;
  }
  if (report.prune) {
    return `Removed ${totals.removed} source-cache entr${totals.removed === 1 ? "y" : "ies"} (${sourceBytes(totals.removedBytes)}).${notes}`;
  }
  const base = `${totals.entries} source-cache entr${totals.entries === 1 ? "y" : "ies"} (${sourceBytes(totals.bytes)}); ${totals.eligible} eligible (${sourceBytes(totals.eligibleBytes)}).`;
  const hint = totals.eligible > 0 ? " Run lando sources:gc --prune to remove eligible entries." : "";
  return `${base}${hint}${notes}`;
};
