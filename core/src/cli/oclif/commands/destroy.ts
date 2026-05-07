import { type DestroyAppResult, destroyApp } from "../../commands/destroy.ts";
/**
 * `lando destroy` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const destroySpec: LandoCommandSpec<DestroyAppResult> = {
  id: "destroy",
  summary: "Destroy the current Lando app (requires confirmation).",
  bootstrap: "app",
  run: () => destroyApp(),
};

export default class DestroyCommand extends LandoCommandBase {
  static override description = destroySpec.summary;
  static override landoSpec: LandoCommandSpec = destroySpec;

  override async run(): Promise<void> {
    await this.runEffect(destroySpec);
  }
}
