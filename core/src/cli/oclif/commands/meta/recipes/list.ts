/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const metaRecipesListSpec: LandoCommandSpec<never> = {
  id: "meta:recipes:list",
  summary: "List canonical recipes shipped with the binary.",
  namespace: "meta",
  topLevelAlias: "recipes",
  bootstrap: "none",
  run: () => Effect.die("not yet implemented: meta:recipes:list"),
};

export default class MetaRecipesListCommand extends LandoCommandBase {
  static override description = metaRecipesListSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaRecipesListSpec)];
  static override landoSpec: LandoCommandSpec = metaRecipesListSpec;

  override async run(): Promise<void> {
    await this.runEffect(metaRecipesListSpec);
  }
}
