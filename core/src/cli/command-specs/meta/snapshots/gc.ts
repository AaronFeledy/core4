import { SnapshotGcReportResultSchema, snapshotGc } from "@lando/engine/operations/snapshot-gc";
import { DataTransferError } from "@lando/sdk/errors";
import type { SnapshotGcReport } from "@lando/sdk/services";
import { Effect } from "effect";
import { renderSnapshotGcReport } from "../../../commands/snapshots-gc";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { nonPromptingYesFlag } from "../../../spec/confirmation-flag";
import { booleanFlag, specFlagsOf } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const snapshotGcOptionsFromInput = (input: unknown) => ({
  prune: booleanFlag(specFlagsOf(input), "prune"),
});

/** Doctor reads failed providers from the report; the command exits nonzero so scripts notice. */
export const failOnFailedProvider = (report: SnapshotGcReport) => {
  const failed = report.providers.filter((provider) => provider.status === "failed");
  if (failed.length === 0) return Effect.succeed(report);
  const reasons = failed.map((provider) => `${provider.provider}: ${provider.error ?? "unknown error"}`);
  return Effect.fail(
    new DataTransferError({
      operation: "snapshotGc",
      message: `Could not ${report.prune ? "clean" : "check"} snapshot images on ${reasons.join("; ")}.${
        report.prune ? ` Removed ${report.removedCount} before the failure.` : ""
      }`,
      remediation: "Fix the provider error, check it with lando doctor, then rerun lando snapshots:gc.",
    }),
  );
};

export const metaSnapshotsGcSpec: LandoCommandSpec<SnapshotGcReport> = {
  id: "meta:snapshots:gc",
  summary: "Inspect orphaned native volume snapshots.",
  namespace: "meta",
  topLevelAlias: "snapshots:gc",
  aliases: ["snapshots:gc"],
  bootstrap: "provider",
  resultSchema: SnapshotGcReportResultSchema,
  flags: {
    yes: nonPromptingYesFlag,
    prune: Flags.boolean({
      description: "Remove orphaned snapshot images after rechecking the snapshot index.",
      default: false,
    }),
  },
  run: (input) => snapshotGc(snapshotGcOptionsFromInput(input)).pipe(Effect.flatMap(failOnFailedProvider)),
  render: (result) => renderSnapshotGcReport(result as SnapshotGcReport),
};
