import { type RebuildAppResult, rebuildApp } from "../../../commands/rebuild.ts";
/**
 * `lando app:rebuild` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const rebuildSpec: LandoCommandSpec<RebuildAppResult> = {
  id: "app:rebuild",
  summary: "Rebuild artifacts and restart the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => rebuildApp(),
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
