/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaXSpec: LandoCommandSpec<never> = {
  id: "meta:x",
  summary: "One-shot package execution via BunSelfRunner.x (bunx-equivalent).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:x"),
};

export default class MetaXCommand extends LandoCommandBase {
  static override description = metaXSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaXSpec)];
  static override landoSpec: LandoCommandSpec = metaXSpec;
  static override bootstrap = metaXSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaXSpec);
  }
}
