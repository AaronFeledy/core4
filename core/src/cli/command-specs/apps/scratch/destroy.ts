import type { ScratchHandle } from "@lando/sdk/services";
import {
  ScratchHandleResultSchema,
  renderScratchDestroyResult,
  scratchDestroy,
  scratchIdFromInput,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { nonPromptingYesFlag } from "../../../spec/confirmation-flag";
import { booleanFlag, specFlagsOf } from "../../../spec/input-coercion";
import { Args, Flags } from "../../../spec/metadata";

export const keepVolumesFromInput = (input: unknown): boolean =>
  booleanFlag(specFlagsOf(input), "keep-volumes");

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
    yes: nonPromptingYesFlag,
    "keep-volumes": Flags.boolean({ description: "Keep scratch volumes for inspection.", default: false }),
  },
  run: (input) => scratchDestroy(scratchIdFromInput(input), { keepVolumes: keepVolumesFromInput(input) }),
  render: (result) => renderScratchDestroyResult(result),
};
