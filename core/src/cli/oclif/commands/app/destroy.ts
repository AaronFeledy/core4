/**
 * `lando app:destroy` — native command metadata adapter.
 */
import { Flags } from "../../metadata";

import { type DestroyAppResult, DestroyAppResultSchema, destroyApp } from "@lando/engine/operations/destroy";
import { renderDestroyAppResult } from "../../../commands/destroy";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base";
import { extractSpecFlags } from "../../command-boundary";

export const destroySpec: LandoCommandSpec<DestroyAppResult> = {
  resultSchema: DestroyAppResultSchema,
  id: "app:destroy",
  summary: "Destroy the current Lando app (preserves volumes unless --purge or --volumes).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: (input) => {
    const flags = extractSpecFlags(input);
    return destroyApp({
      volumes: flags.volumes === true || flags.purge === true,
      purgeCaches: flags["purge-caches"] === true,
      yes: flags.yes === true,
    });
  },
  render: (result) => renderDestroyAppResult(result as DestroyAppResult),
};

export default class DestroyCommand extends LandoCommandBase {
  static override description = destroySpec.summary;
  static override aliases = [...resolveTopLevelAliases(destroySpec)];
  static override flags = {
    volumes: Flags.boolean({
      description: "Also remove app/service-scoped storage volumes.",
      default: false,
    }),
    purge: Flags.boolean({
      description: "Also remove app/service-scoped storage volumes and snapshots.",
      default: false,
    }),
    "purge-caches": Flags.boolean({
      description: "Remove cache storage volumes.",
      default: false,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Skip the confirmation prompt (no-op until interactive prompts land).",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = destroySpec;
  static override bootstrap = destroySpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(destroySpec);
  }
}
