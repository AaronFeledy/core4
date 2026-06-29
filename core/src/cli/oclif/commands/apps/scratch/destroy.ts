import { Args, Flags } from "@oclif/core";

import type { ScratchHandle } from "@lando/sdk/services";
import {
  ScratchHandleResultSchema,
  renderScratchDestroyResult,
  scratchDestroy,
  scratchIdFromInput,
} from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const keepVolumesFromInput = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const flags = (input as { readonly flags?: Record<string, unknown> }).flags ?? {};
  return flags["keep-volumes"] === true;
};

export const appsScratchDestroySpec: LandoCommandSpec<ScratchHandle> = {
  resultSchema: ScratchHandleResultSchema,
  id: "apps:scratch:destroy",
  summary: "Destroy a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:destroy",
  bootstrap: "scratch",
  run: (input) => scratchDestroy(scratchIdFromInput(input), { keepVolumes: keepVolumesFromInput(input) }),
  render: (result) => renderScratchDestroyResult(result as ScratchHandle),
};

export default class AppsScratchDestroyCommand extends LandoCommandBase {
  static override description = appsScratchDestroySpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchDestroySpec)];
  static override args = {
    id: Args.string({ description: "Scratch app id.", required: true }),
  };
  static override flags = {
    "keep-volumes": Flags.boolean({ description: "Keep scratch volumes for inspection.", default: false }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchDestroySpec;
  static override bootstrap = appsScratchDestroySpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchDestroySpec);
  }
}
