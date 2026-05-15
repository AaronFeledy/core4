/**
 * `lando meta:shellenv` — print shell-profile snippets to add Lando to PATH.
 *
 * **CLI-only** — not exported from `@lando/core/cli`.
 */
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const installDir = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/[\\/]$/, "");
const shellenvOutput = `export LANDO_INSTALL_DIR="${installDir}"
export PATH="\${LANDO_INSTALL_DIR}/bin:\${PATH}"`;

export const shellenvSpec: LandoCommandSpec<string> = {
  id: "meta:shellenv",
  summary: "Print shell-profile snippets to integrate Lando into your PATH.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  run: () => Effect.succeed(shellenvOutput),
  render: (result) => (typeof result === "string" ? result : undefined),
};

export default class ShellenvCommand extends LandoCommandBase {
  static override description = shellenvSpec.summary;
  static override aliases = [...resolveTopLevelAliases(shellenvSpec)];
  static override landoSpec: LandoCommandSpec = shellenvSpec;
  static override bootstrap = shellenvSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(shellenvSpec);
  }
}
