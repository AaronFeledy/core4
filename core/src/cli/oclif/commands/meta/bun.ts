/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaBunSpec: LandoCommandSpec<never> = {
  id: "meta:bun",
  summary: "Proxy to the embedded Bun CLI via BunSelfRunner.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:bun"),
};

export default class MetaBunCommand extends LandoCommandBase {
  static override description = metaBunSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaBunSpec)];
  static override landoSpec: LandoCommandSpec = metaBunSpec;
  static override bootstrap = metaBunSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaBunSpec);
  }
}
