import type { ScratchHandle } from "@lando/sdk/services";
import {
  ScratchHandleResultSchema,
  renderScratchStopResult,
  scratchIdFromInput,
  scratchStop,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { nonPromptingYesFlag } from "../../../spec/confirmation-flag";
import { Args } from "../../../spec/metadata";

export const appsScratchStopSpec: LandoCommandSpec<ScratchHandle> = {
  resultSchema: ScratchHandleResultSchema,
  id: "apps:scratch:stop",
  summary: "Stop and destroy a scratch Lando app.",
  description:
    "A scratch app cannot be restarted, so stopping one destroys it the way `scratch:destroy` does: its containers, volumes, and snapshots are removed. Use `scratch:destroy --keep-volumes` to keep its volumes for inspection.",
  namespace: "apps",
  topLevelAlias: "scratch:stop",
  aliases: ["scratch:stop"],
  bootstrap: "scratch",
  flags: { yes: nonPromptingYesFlag },
  args: {
    id: Args.string({ description: "Scratch app id or the --name it was started with.", required: true }),
  },
  run: (input) => scratchStop(scratchIdFromInput(input)),
  render: (result) => renderScratchStopResult(result),
};
