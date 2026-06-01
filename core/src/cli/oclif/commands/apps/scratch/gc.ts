import { Flags } from "@oclif/core";

import type { ScratchGcReport } from "@lando/sdk/services";
import { renderScratchGcReport, scratchGc } from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pruneFromInput = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const flags = (input as { readonly flags?: Record<string, unknown> }).flags ?? {};
  return flags.prune === true;
};

export const appsScratchGcSpec: LandoCommandSpec<ScratchGcReport> = {
  id: "apps:scratch:gc",
  summary: "Inspect scratch Lando app orphans.",
  namespace: "apps",
  topLevelAlias: "scratch:gc",
  bootstrap: "scratch",
  run: (input) => scratchGc({ prune: pruneFromInput(input) }),
  render: (result) => renderScratchGcReport(result as ScratchGcReport),
};

export default class AppsScratchGcCommand extends LandoCommandBase {
  static override description = appsScratchGcSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchGcSpec)];
  static override flags = {
    prune: Flags.boolean({
      description: "Reap orphaned scratch resources after reporting them.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchGcSpec;
  static override bootstrap = appsScratchGcSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchGcSpec);
  }
}
