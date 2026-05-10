/**
 * SPEC: §8.2 canonical id `app:shell`.
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const appShellSpec: LandoCommandSpec<never> = {
  id: "app:shell",
  summary: "Open an interactive Bun Shell scoped to the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => Effect.die("not yet implemented: app:shell"),
};

export default class AppShellCommand extends LandoCommandBase {
  static override description = appShellSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appShellSpec)];
  static override landoSpec: LandoCommandSpec = appShellSpec;

  override async run(): Promise<void> {
    await this.runEffect(appShellSpec);
  }
}
