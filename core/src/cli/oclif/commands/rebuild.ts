import { type RebuildAppResult, rebuildApp } from "../../commands/rebuild.ts";
/**
 * `lando rebuild` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const rebuildSpec: LandoCommandSpec<RebuildAppResult> = {
  id: "rebuild",
  summary: "Rebuild artifacts and restart the current app.",
  bootstrap: "app",
  run: () => rebuildApp(),
};

export default class RebuildCommand extends LandoCommandBase {
  static override description = rebuildSpec.summary;
  static override landoSpec: LandoCommandSpec = rebuildSpec;

  override async run(): Promise<void> {
    await this.runEffect(rebuildSpec);
  }
}
