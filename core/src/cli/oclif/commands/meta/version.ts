/**
 * `lando meta:version` — OCLIF Command class wrapping the Effect operation.
 *
 * Bootstrap: `none`. The pure Effect operation lives at
 * `core/src/cli/commands/version.ts` (so `@lando/core/cli` can re-export
 * it without pulling OCLIF).
 */
import { type VersionResult, VersionResultSchema, version } from "../../../commands/version.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const versionSpec: LandoCommandSpec<VersionResult, never> = {
  resultSchema: VersionResultSchema,
  id: "meta:version",
  mcpAllowed: true,
  summary: "Show the Lando + Bun + plugin versions.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  run: () => version,
  render: (result) => {
    if (typeof result !== "object" || result === null || !("core" in result)) return undefined;
    const { core, bun, platform } = result as VersionResult;
    return `@lando/core ${core} (bun ${bun} on ${platform})`;
  },
};

export default class VersionCommand extends LandoCommandBase {
  static override description = versionSpec.summary;
  static override hidden = false;
  static override aliases = ["--version", "-v", ...resolveTopLevelAliases(versionSpec)];
  static override landoSpec: LandoCommandSpec = versionSpec;
  static override bootstrap = versionSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(versionSpec);
  }
}
