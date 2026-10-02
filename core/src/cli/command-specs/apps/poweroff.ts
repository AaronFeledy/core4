import {
  type PoweroffResult,
  PoweroffResultSchema,
  poweroff,
  renderPoweroffResult,
} from "../../commands/poweroff";
import { Flags } from "../../spec/metadata";

import type { LandoCommandSpec } from "../../spec/command-base";
import { specFlagsOf } from "../../spec/input-coercion";

export const poweroffSpec: LandoCommandSpec<PoweroffResult> = {
  resultSchema: PoweroffResultSchema,
  id: "apps:poweroff",
  summary: "Stop every Lando-managed service across apps.",
  namespace: "apps",
  topLevelAlias: true,
  aliases: ["poweroff"],
  bootstrap: "scratch",
  flags: {
    "keep-global": Flags.boolean({ description: "Do not stop the global app.", default: false }),
    "keep-scratch": Flags.boolean({ description: "Do not stop scratch apps.", default: false }),
    yes: Flags.boolean({ char: "y", description: "Skip confirmation prompts.", default: false }),
  },
  run: (input) => {
    const flags = specFlagsOf(input);
    return poweroff({
      keepGlobal: flags["keep-global"] === true,
      keepScratch: flags["keep-scratch"] === true,
      yes: flags.yes === true,
    });
  },
  render: (result) => renderPoweroffResult(result as PoweroffResult),
};
