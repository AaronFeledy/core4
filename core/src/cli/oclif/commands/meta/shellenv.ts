/**
 * `lando meta:shellenv` — print shell-profile snippets to add
 * `<userConfRoot>/bin` to PATH.
 *
 * **CLI-only** — not exported from `@lando/core/cli`.
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const shellenvSpec: LandoCommandSpec<never> = {
  id: "meta:shellenv",
  summary: "Print shell-profile snippets to integrate Lando into your PATH.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  run: () => Effect.die("not yet implemented: meta:shellenv"),
};

export default class ShellenvCommand extends LandoCommandBase {
  static override description = shellenvSpec.summary;
  static override aliases = [...resolveTopLevelAliases(shellenvSpec)];
  static override landoSpec: LandoCommandSpec = shellenvSpec;

  override async run(): Promise<void> {
    await this.runEffect(shellenvSpec);
  }
}
