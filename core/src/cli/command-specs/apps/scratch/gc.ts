import { Flags } from "../../../spec/metadata";

import type { ScratchGcReport } from "@lando/sdk/services";
import { ScratchGcReportResultSchema, renderScratchGcReport, scratchGc } from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { booleanFlag, specFlagsOf } from "../../../spec/input-coercion";

export const pruneFromInput = (input: unknown): boolean => booleanFlag(specFlagsOf(input), "prune");

export const appsScratchGcSpec: LandoCommandSpec<ScratchGcReport> = {
  resultSchema: ScratchGcReportResultSchema,
  id: "apps:scratch:gc",
  summary: "Inspect scratch Lando app orphans.",
  namespace: "apps",
  topLevelAlias: "scratch:gc",
  aliases: ["scratch:gc"],
  bootstrap: "scratch",
  flags: {
    prune: Flags.boolean({
      description: "Reap orphaned scratch resources after reporting them.",
      default: false,
    }),
  },
  run: (input) => scratchGc({ prune: pruneFromInput(input) }),
  render: (result) => renderScratchGcReport(result as ScratchGcReport),
};
