import { Flags } from "../../../spec/metadata";

import type { ScratchGcReport } from "@lando/sdk/services";
import { ScratchGcReportResultSchema, renderScratchGcReport, scratchGc } from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const pruneFromInput = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const flags = (input as { readonly flags?: Record<string, unknown> }).flags ?? {};
  return flags.prune === true;
};

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
