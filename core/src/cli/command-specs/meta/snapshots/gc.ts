import { SnapshotGcReportResultSchema, snapshotGc } from "@lando/engine/operations/snapshot-gc";
import type { SnapshotGcReport } from "@lando/sdk/services";
import { renderSnapshotGcReport } from "../../../commands/snapshots-gc";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { booleanFlag, specFlagsOf } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const snapshotGcOptionsFromInput = (input: unknown) => ({
  prune: booleanFlag(specFlagsOf(input), "prune"),
});

export const metaSnapshotsGcSpec: LandoCommandSpec<SnapshotGcReport> = {
  id: "meta:snapshots:gc",
  summary: "Inspect orphaned native volume snapshots.",
  namespace: "meta",
  topLevelAlias: "snapshots:gc",
  aliases: ["snapshots:gc"],
  bootstrap: "provider",
  resultSchema: SnapshotGcReportResultSchema,
  flags: {
    prune: Flags.boolean({
      description: "Remove orphaned snapshot images after rechecking the snapshot index.",
      default: false,
    }),
  },
  run: (input) => snapshotGc(snapshotGcOptionsFromInput(input)),
  render: (result) => renderSnapshotGcReport(result as SnapshotGcReport),
};
