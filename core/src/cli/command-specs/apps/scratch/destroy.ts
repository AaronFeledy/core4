import { Args, Flags } from "../../../spec/metadata";

import type { ScratchHandle } from "@lando/sdk/services";
import {
  ScratchHandleResultSchema,
  renderScratchDestroyResult,
  scratchDestroy,
  scratchIdFromInput,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

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
  aliases: ["scratch:destroy"],
  bootstrap: "scratch",
  args: {
    id: Args.string({ description: "Scratch app id.", required: true }),
  },
  flags: {
    "keep-volumes": Flags.boolean({ description: "Keep scratch volumes for inspection.", default: false }),
  },
  run: (input) => scratchDestroy(scratchIdFromInput(input), { keepVolumes: keepVolumesFromInput(input) }),
  render: (result) => renderScratchDestroyResult(result as ScratchHandle),
};
