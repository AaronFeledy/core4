import { Flags } from "@oclif/core";
import { type PoweroffResult, poweroff, renderPoweroffResult } from "../../../commands/poweroff.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const extractFlags = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {};
  return (input as { flags?: Record<string, unknown> }).flags ?? {};
};

export const poweroffSpec: LandoCommandSpec<PoweroffResult> = {
  id: "apps:poweroff",
  summary: "Stop every Lando-managed service across apps.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "minimal",
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

export default class PoweroffCommand extends LandoCommandBase {
  static override description = poweroffSpec.summary;
  static override aliases = [...resolveTopLevelAliases(poweroffSpec)];
  static override flags = {
    "keep-global": Flags.boolean({ description: "Do not stop the global app.", default: false }),
    "keep-scratch": Flags.boolean({ description: "Do not stop scratch apps.", default: false }),
    yes: Flags.boolean({ char: "y", description: "Skip confirmation prompts.", default: false }),
  };
  static override landoSpec: LandoCommandSpec = poweroffSpec;
  static override bootstrap = poweroffSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(poweroffSpec);
  }
}
