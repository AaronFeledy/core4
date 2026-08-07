import { type StartAppResult, StartAppResultSchema, startApp } from "../../../../operations/start.ts";
import { renderStartAppResult } from "../../../commands/start-result.ts";
/**
 * `lando app:start` — native command metadata adapter.
 */
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../command-base.ts";

import { StreamFrame } from "@lando/sdk/schema";

export const startSpec: LandoCommandSpec<StartAppResult> = {
  resultSchema: StartAppResultSchema,
  id: "app:start",
  mcpAllowed: true,
  summary: "Start the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return startApp(signal === undefined ? {} : { signal });
  },
  render: (result) => renderStartAppResult(result as StartAppResult),
};

export default class StartCommand extends LandoCommandBase {
  static override description = startSpec.summary;
  static override aliases = [...resolveTopLevelAliases(startSpec)];
  static override landoSpec: LandoCommandSpec = startSpec;
  static override bootstrap = startSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(startSpec);
  }
}
