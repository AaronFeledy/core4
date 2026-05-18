import { type StartAppResult, renderStartAppResult, startApp } from "../../../commands/start.ts";
/**
 * `lando app:start` — OCLIF wrapper.
 */
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../command-base.ts";

export const startSpec: LandoCommandSpec<StartAppResult> = {
  id: "app:start",
  summary: "Start the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
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
