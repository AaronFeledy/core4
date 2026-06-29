import { Args } from "@oclif/core";

import type { ScratchHandle } from "@lando/sdk/services";
import {
  ScratchHandleResultSchema,
  renderScratchStopResult,
  scratchIdFromInput,
  scratchStop,
} from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appsScratchStopSpec: LandoCommandSpec<ScratchHandle> = {
  resultSchema: ScratchHandleResultSchema,
  id: "apps:scratch:stop",
  summary: "Stop a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:stop",
  bootstrap: "scratch",
  run: (input) => scratchStop(scratchIdFromInput(input)),
  render: (result) => renderScratchStopResult(result as ScratchHandle),
};

export default class AppsScratchStopCommand extends LandoCommandBase {
  static override description = appsScratchStopSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchStopSpec)];
  static override args = {
    id: Args.string({ description: "Scratch app id.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchStopSpec;
  static override bootstrap = appsScratchStopSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchStopSpec);
  }
}
