import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec } from "../../../../../src/cli/oclif/command-base.ts";

const missingSpec: LandoCommandSpec<void> = {
  id: "missing",
  summary: "Missing bootstrap fixture.",
  namespace: "meta",
  bootstrap: "minimal",
  run: () => Effect.void,
};

export default class MissingCommand extends LandoCommandBase {
  static override description = missingSpec.summary;
  static override landoSpec: LandoCommandSpec = missingSpec;

  override async run(): Promise<void> {
    await this.runEffect(missingSpec);
  }
}
