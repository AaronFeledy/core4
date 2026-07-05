import {
  type GlobalRestartResult,
  GlobalRestartResultSchema,
  globalRestart,
  renderGlobalRestartResult,
} from "../../../../commands/meta/global-restart.ts";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

export const metaGlobalRestartSpec: LandoCommandSpec<GlobalRestartResult> = {
  resultSchema: GlobalRestartResultSchema,
  id: "meta:global:restart",
  summary: "Restart the host-level global Lando app (stop + start).",
  namespace: "meta",
  topLevelAlias: "global:restart",
  bootstrap: "global",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return globalRestart(signal === undefined ? {} : { signal });
  },
  render: (result) => renderGlobalRestartResult(result as GlobalRestartResult),
};

export default class MetaGlobalRestartCommand extends LandoCommandBase {
  static override description = metaGlobalRestartSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalRestartSpec)];
  static override landoSpec: LandoCommandSpec = metaGlobalRestartSpec;
  static override bootstrap = metaGlobalRestartSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalRestartSpec);
  }
}
