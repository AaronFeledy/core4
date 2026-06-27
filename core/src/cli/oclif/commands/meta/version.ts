/**
 * `lando meta:version` — OCLIF Command class wrapping the Effect operation.
 *
 * Bootstrap: `none`. The pure Effect operation lives at
 * `core/src/cli/commands/version.ts` (so `@lando/core/cli` can re-export
 * it without pulling OCLIF).
 */
import { Effect } from "effect";

import { type VersionResult, version } from "../../../commands/version.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

export const versionSpec: LandoCommandSpec<VersionResult, never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:version",
  summary: "Show the Lando + Bun + plugin versions.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  run: () => version,
};

export default class VersionCommand extends LandoCommandBase {
  static override description = versionSpec.summary;
  static override hidden = false;
  static override aliases = ["--version", "-v", ...resolveTopLevelAliases(versionSpec)];
  static override landoSpec: LandoCommandSpec = versionSpec;
  static override bootstrap = versionSpec.bootstrap;

  override async run(): Promise<void> {
    // Until LandoCommandBase.runEffect is implemented, run the Effect inline
    // so the placeholder CLI smoke-tests print *something*.
    const result = await Effect.runPromise(version);
    this.log(`@lando/core ${result.core} (bun ${result.bun} on ${result.platform})`);
  }
}
