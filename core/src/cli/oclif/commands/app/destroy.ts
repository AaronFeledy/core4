/**
 * `lando app:destroy` — OCLIF wrapper.
 */
import { Flags } from "@oclif/core";

import { type DestroyAppResult, destroyApp, renderDestroyAppResult } from "../../../commands/destroy.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

interface DestroyFlags {
  readonly purge: boolean;
  readonly "purge-caches": boolean;
  readonly volumes: boolean;
  readonly yes: boolean;
}

export const destroySpec: LandoCommandSpec<DestroyAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:destroy",
  summary: "Destroy the current Lando app (preserves volumes unless --purge or --volumes).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => destroyApp(),
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
    const { flags } = (await this.parse(DestroyCommand)) as { readonly flags: DestroyFlags };
    await this.runEffect({
      ...destroySpec,
      run: () =>
        destroyApp({
          volumes: flags.volumes || flags.purge,
          purgeCaches: flags["purge-caches"],
          yes: flags.yes,
        }),
    });
  }
}
