import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { type PoweroffResult, poweroff, renderPoweroffResult } from "../../../commands/poweroff.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface PoweroffFlags {
  readonly "keep-global"?: boolean;
  readonly "keep-scratch"?: boolean;
  readonly yes?: boolean;
}

const extractFlags = (input: unknown): PoweroffFlags => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return {
    "keep-global": flags["keep-global"] === true,
    "keep-scratch": flags["keep-scratch"] === true,
    yes: flags.yes === true,
  };
};

export const poweroffSpec: LandoCommandSpec<PoweroffResult> = {
  id: "apps:poweroff",
  summary: "Stop every Lando-managed service across apps.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) =>
    Effect.gen(function* () {
      const flags = extractFlags(input);
      return yield* poweroff({
        keepGlobal: flags["keep-global"] === true,
        keepScratch: flags["keep-scratch"] === true,
        yes: flags.yes === true,
      });
    }),
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
