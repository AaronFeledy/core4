import { Effect } from "effect";

import type { BootstrapLevel } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

import { LandoCommandBase, type LandoCommandSpec } from "../../../../../src/cli/oclif/command-base.ts";
import { events } from "../events.ts";

const minimalSpec: LandoCommandSpec<void> = {
  id: "minimal",
  summary: "Minimal bootstrap fixture.",
  namespace: "meta",
  bootstrap: "minimal",
  run: () =>
    Effect.gen(function* () {
      events.push("minimal-effect");
      yield* RuntimeProvider;
      yield* Effect.sync(() => {
        events.push("minimal-unexpected");
      });
    }),
};

export default class MinimalCommand extends LandoCommandBase {
  static override description = minimalSpec.summary;
  static override landoSpec: LandoCommandSpec = minimalSpec;
  static override bootstrap: BootstrapLevel = minimalSpec.bootstrap;

  override async run(): Promise<void> {
    events.push("minimal-command");
    await this.runEffect(minimalSpec);
  }
}
