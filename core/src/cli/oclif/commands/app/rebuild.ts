import { type RebuildAppResult, rebuildApp, renderRebuildAppResult } from "../../../commands/rebuild.ts";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../command-base.ts";

export const rebuildSpec: LandoCommandSpec<RebuildAppResult> = {
  id: "app:rebuild",
  summary: "Rebuild artifacts and restart the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return rebuildApp(signal === undefined ? {} : { signal });
  },
  render: (result) => renderRebuildAppResult(result as RebuildAppResult),
};

export default class RebuildCommand extends LandoCommandBase {
  static override description = rebuildSpec.summary;
  static override aliases = [...resolveTopLevelAliases(rebuildSpec)];
  static override landoSpec: LandoCommandSpec = rebuildSpec;
  static override bootstrap = rebuildSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(rebuildSpec);
  }
}
