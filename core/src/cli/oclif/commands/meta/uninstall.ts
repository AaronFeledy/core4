/**
 * SPEC: §8.2 canonical id `meta:uninstall`.
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaUninstallSpec: LandoCommandSpec<never> = {
  id: "meta:uninstall",
  summary: "Remove Lando-owned installed files after confirmation.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:uninstall"),
};

export default class MetaUninstallCommand extends LandoCommandBase {
  static override description = metaUninstallSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaUninstallSpec)];
  static override landoSpec: LandoCommandSpec = metaUninstallSpec;

  override async run(): Promise<void> {
    await this.runEffect(metaUninstallSpec);
  }
}
