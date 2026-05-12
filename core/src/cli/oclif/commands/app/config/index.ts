/**
 * `lando app:config` — OCLIF wrapper.
 *
 * Reads or writes the current app's Landofile (app-scoped). The bare
 * `lando config` alias maps to the global `meta:config` command, not this
 * one — `app:config` registers no top-level alias.
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appConfigSpec: LandoCommandSpec<never> = {
  id: "app:config",
  summary: "Read or write the current app's Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  run: () => Effect.die("not yet implemented: app:config"),
};

export default class AppConfigCommand extends LandoCommandBase {
  static override description = appConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigSpec)];
  static override landoSpec: LandoCommandSpec = appConfigSpec;
  static override bootstrap = appConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appConfigSpec);
  }
}
