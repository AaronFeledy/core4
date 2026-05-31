import { Args } from "@oclif/core";

import {
  type ScratchLogsResult,
  renderScratchLogsResult,
  scratchIdFromInput,
  scratchLogs,
} from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appsScratchLogsSpec: LandoCommandSpec<ScratchLogsResult> = {
  id: "apps:scratch:logs",
  summary: "Show logs for a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:logs",
  bootstrap: "scratch",
  run: (input) => scratchLogs(scratchIdFromInput(input)),
  render: (result) => renderScratchLogsResult(result as ScratchLogsResult),
};

export default class AppsScratchLogsCommand extends LandoCommandBase {
  static override description = appsScratchLogsSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchLogsSpec)];
  static override args = {
    id: Args.string({ description: "Scratch app id.", required: false }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchLogsSpec;
  static override bootstrap = appsScratchLogsSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchLogsSpec);
  }
}
