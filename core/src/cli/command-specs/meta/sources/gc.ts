import {
  type SourceGcReport,
  SourceGcReportResultSchema,
  sourceCacheGc,
} from "@lando/engine/operations/source-cache-gc";
import { DataTransferError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { renderSourceGcReport } from "../../../commands/sources-gc";
import { MalformedCliFlagValueError } from "../../../flag-value-validation";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { nonPromptingYesFlag } from "../../../spec/confirmation-flag";
import { booleanFlag, specFlagsOf } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const sourceGcOptionsFromInput = (
  input: unknown,
): {
  readonly prune: boolean;
  readonly olderThanDays: number;
} => {
  const flags = specFlagsOf(input);
  const raw = flags["older-than"];
  const olderThanDays = typeof raw === "number" ? raw : 30;
  return {
    prune: booleanFlag(flags, "prune"),
    olderThanDays,
  };
};

/** Exit nonzero so scripts notice partial GC failures. */
export const failOnFailedEntries = (report: SourceGcReport) => {
  if (report.totals.failed <= 0) return Effect.succeed(report);
  const failures = [...report.entries, ...report.leftovers]
    .filter((row) => row.outcome === "failed")
    .map((row) => `${row.kind}/${row.id}: ${row.reason ?? "Cache operation failed."}`)
    .join("; ");
  return Effect.fail(
    new DataTransferError({
      operation: "sourceCacheGc",
      message: `Could not ${report.prune ? "clean" : "check"} the source cache: ${report.totals.failed} entr${
        report.totals.failed === 1 ? "y" : "ies"
      } failed.${report.prune ? ` Removed ${report.totals.removed} before the failure.` : ""} ${failures}`,
      remediation: "Fix the reported cache errors, then rerun lando sources:gc.",
    }),
  );
};

export const metaSourcesGcSpec: LandoCommandSpec<SourceGcReport> = {
  id: "meta:sources:gc",
  summary: "Inspect unused entries in the remote source cache.",
  namespace: "meta",
  topLevelAlias: "sources:gc",
  aliases: ["sources:gc"],
  bootstrap: "minimal",
  resultSchema: SourceGcReportResultSchema,
  flags: {
    yes: nonPromptingYesFlag,
    prune: Flags.boolean({
      description: "Remove eligible source-cache entries after rechecking reachability and leases.",
      default: false,
    }),
    "older-than": Flags.integer({
      description: "Only consider entries unused for at least this many days (default 30).",
      default: 30,
      min: 0,
    }),
  },
  run: (input) => {
    const options = sourceGcOptionsFromInput(input);
    if (options.olderThanDays < 0) {
      return Effect.fail(
        new MalformedCliFlagValueError({
          message: `--older-than has a malformed value: ${String(options.olderThanDays)}.`,
          flag: "older-than",
          issue: "invalid_integer",
          remediation: "Pass a non-negative whole number of days, e.g. --older-than=30.",
        }),
      );
    }
    return sourceCacheGc(options).pipe(Effect.flatMap(failOnFailedEntries));
  },
  render: (result) => renderSourceGcReport(result),
};
