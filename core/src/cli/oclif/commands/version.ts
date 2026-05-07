/**
 * `lando version` — OCLIF Command class wrapping the Effect operation.
 *
 * Bootstrap: `minimal`. The pure Effect operation lives at
 * `core/src/cli/commands/version.ts` (so `@lando/core/cli` can re-export
 * it without pulling OCLIF).
 */
import { Effect } from "effect";

import { type VersionResult, version } from "../../commands/version.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const versionSpec: LandoCommandSpec<VersionResult, never> = {
  id: "version",
  summary: "Show the Lando + Bun + plugin versions.",
  bootstrap: "minimal",
  run: () => version,
};

export default class VersionCommand extends LandoCommandBase {
  static override description = versionSpec.summary;
  static override hidden = false;
  static override aliases = ["--version", "-v"];
  static override landoSpec: LandoCommandSpec = versionSpec;

  override async run(): Promise<void> {
    // Until LandoCommandBase.runEffect is implemented, run the Effect inline
    // so the placeholder CLI smoke-tests print *something*.
    const result = await Effect.runPromise(version);
    this.log(`@lando/core ${result.core} (bun ${result.bun} on ${result.platform})`);
  }
}
