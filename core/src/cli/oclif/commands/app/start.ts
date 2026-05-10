import { type StartAppResult, startApp } from "../../../commands/start.ts";
/**
 * SPEC: §8.2 canonical id `app:start`.
 * `lando app:start` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const startSpec: LandoCommandSpec<StartAppResult> = {
  id: "app:start",
  summary: "Start the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => startApp(),
};

export default class StartCommand extends LandoCommandBase {
  static override description = startSpec.summary;
  static override aliases = [...resolveTopLevelAliases(startSpec)];
  static override landoSpec: LandoCommandSpec = startSpec;

  override async run(): Promise<void> {
    await this.runEffect(startSpec);
  }
}
