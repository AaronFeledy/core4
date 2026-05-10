import { type DestroyAppResult, destroyApp } from "../../../commands/destroy.ts";
/**
 * SPEC: §8.2 canonical id `app:destroy`.
 * `lando app:destroy` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const destroySpec: LandoCommandSpec<DestroyAppResult> = {
  id: "app:destroy",
  summary: "Destroy the current Lando app (requires confirmation).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => destroyApp(),
};

export default class DestroyCommand extends LandoCommandBase {
  static override description = destroySpec.summary;
  static override aliases = [...resolveTopLevelAliases(destroySpec)];
  static override landoSpec: LandoCommandSpec = destroySpec;

  override async run(): Promise<void> {
    await this.runEffect(destroySpec);
  }
}
