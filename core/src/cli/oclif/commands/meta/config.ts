/**
 * SPEC: §8.2 canonical id `meta:config`.
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaConfigSpec: LandoCommandSpec<never> = {
  id: "meta:config",
  summary: "Read/write global Lando config.",
  namespace: "meta",
  topLevelAlias: "config",
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:config"),
};

export default class MetaConfigCommand extends LandoCommandBase {
  static override description = metaConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaConfigSpec)];
  static override landoSpec: LandoCommandSpec = metaConfigSpec;

  override async run(): Promise<void> {
    await this.runEffect(metaConfigSpec);
  }
}
