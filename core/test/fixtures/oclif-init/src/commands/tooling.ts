import { Effect } from "effect";

import type { BootstrapLevel } from "@lando/sdk/schema";
import { CommandRegistry, RuntimeProvider } from "@lando/sdk/services";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
} from "../../../../../src/cli/oclif/command-base.ts";
import { events } from "../events.ts";

const toolingSpec: LandoCommandSpec<void> = {
  id: "tooling",
  summary: "Tooling bootstrap fixture.",
  namespace: "meta",
  bootstrap: "tooling",
  resultSchema: EmptyResultSchema,
  run: () =>
    Effect.gen(function* () {
      events.push("tooling-effect");
      yield* CommandRegistry;
      yield* Effect.sync(() => {
        events.push("tooling-command-registry");
      });
      yield* RuntimeProvider;
      yield* Effect.sync(() => {
        events.push("tooling-unexpected-provider");
      });
    }),
};

export default class ToolingCommand extends LandoCommandBase {
  static override description = toolingSpec.summary;
  static override landoSpec: LandoCommandSpec = toolingSpec;
  static override bootstrap: BootstrapLevel = toolingSpec.bootstrap;

  override async run(): Promise<void> {
    events.push("tooling-command");
    await this.runEffect(toolingSpec);
  }
}
