import {
  type PoweroffResult,
  PoweroffResultSchema,
  poweroff,
  renderPoweroffResult,
} from "../../commands/poweroff";
import { Flags } from "../../spec/metadata";

import type { LandoCommandSpec } from "../../spec/command-base";

const extractFlags = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {};
  return (input as { flags?: Record<string, unknown> }).flags ?? {};
};

export const poweroffSpec: LandoCommandSpec<PoweroffResult> = {
  resultSchema: PoweroffResultSchema,
  id: "apps:poweroff",
  summary: "Stop every Lando-managed service across apps.",
  namespace: "apps",
  topLevelAlias: true,
  aliases: ["poweroff"],
  bootstrap: "minimal",
  flags: {
    "keep-global": Flags.boolean({ description: "Do not stop the global app.", default: false }),
    "keep-scratch": Flags.boolean({ description: "Do not stop scratch apps.", default: false }),
    yes: Flags.boolean({ char: "y", description: "Skip confirmation prompts.", default: false }),
  },
  run: (input) => {
    const flags = extractFlags(input);
    return poweroff({
      keepGlobal: flags["keep-global"] === true,
      keepScratch: flags["keep-scratch"] === true,
      yes: flags.yes === true,
    });
  },
  render: (result) => renderPoweroffResult(result as PoweroffResult),
};
