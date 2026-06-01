import { Flags } from "@oclif/core";

import {
  type GlobalDestroyOptions,
  type GlobalDestroyResult,
  globalDestroy,
  renderGlobalDestroyResult,
} from "../../../../commands/meta/global-destroy.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const globalDestroyOptionsFromInput = (input: unknown): GlobalDestroyOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return { yes: flags.yes === true, purge: flags.purge === true };
};

export const metaGlobalDestroySpec: LandoCommandSpec<GlobalDestroyResult> = {
  id: "meta:global:destroy",
  summary: "Destroy the host-level global Lando app provider resources.",
  namespace: "meta",
  topLevelAlias: "global:destroy",
  bootstrap: "global",
  run: (input) => globalDestroy(globalDestroyOptionsFromInput(input)),
  render: (result) => renderGlobalDestroyResult(result as GlobalDestroyResult),
};

export default class MetaGlobalDestroyCommand extends LandoCommandBase {
  static override description = metaGlobalDestroySpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalDestroySpec)];
  static override flags = {
    yes: Flags.boolean({
      char: "y",
      description: "Confirm destruction of global app provider resources.",
      default: false,
    }),
    purge: Flags.boolean({
      description: "Also remove global service data volumes.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalDestroySpec;
  static override bootstrap = metaGlobalDestroySpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalDestroySpec);
  }
}
