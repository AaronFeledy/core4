import { Effect } from "effect";

import type { BootstrapLevel } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

import { LandoCommandBase, type LandoCommandSpec } from "../../../../../src/cli/oclif/command-base.ts";
import { events } from "../events.ts";

const providerSpec: LandoCommandSpec<void> = {
  id: "provider",
  summary: "Provider bootstrap fixture.",
  namespace: "meta",
  bootstrap: "provider",
  run: () =>
    Effect.gen(function* () {
      events.push("provider-effect");
      yield* RuntimeProvider;
      yield* Effect.sync(() => {
        events.push("provider-runtime");
      });
    }),
};

export default class ProviderCommand extends LandoCommandBase {
  static override description = providerSpec.summary;
  static override landoSpec: LandoCommandSpec = providerSpec;
  static override bootstrap: BootstrapLevel = providerSpec.bootstrap;

  override async run(): Promise<void> {
    events.push("provider-command");
    await this.runEffect(providerSpec);
  }
}
