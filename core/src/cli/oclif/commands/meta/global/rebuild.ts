import {
  type GlobalRebuildResult,
  GlobalRebuildResultSchema,
  globalRebuild,
  renderGlobalRebuildResult,
} from "../../../../commands/meta/global-rebuild.ts";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

export const metaGlobalRebuildSpec: LandoCommandSpec<GlobalRebuildResult> = {
  resultSchema: GlobalRebuildResultSchema,
  id: "meta:global:rebuild",
  summary: "Rebuild the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:rebuild",
  bootstrap: "global",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return globalRebuild(signal === undefined ? {} : { signal });
  },
  render: (result) => renderGlobalRebuildResult(result as GlobalRebuildResult),
};

export default class MetaGlobalRebuildCommand extends LandoCommandBase {
  static override description = metaGlobalRebuildSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalRebuildSpec)];
  static override landoSpec: LandoCommandSpec = metaGlobalRebuildSpec;
  static override bootstrap = metaGlobalRebuildSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalRebuildSpec);
  }
}
