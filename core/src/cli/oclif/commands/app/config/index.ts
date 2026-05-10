import { type ConfigResult, config } from "../../../../commands/config.ts";
/**
 * SPEC: §8.2 canonical id `app:config`.
 * `lando app:config` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const configSpec: LandoCommandSpec<ConfigResult> = {
  id: "app:config",
  summary: "Read or write the current app's Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  run: () => config(),
};

export default class ConfigCommand extends LandoCommandBase {
  static override description = configSpec.summary;
  static override aliases = [...resolveTopLevelAliases(configSpec)];
  static override landoSpec: LandoCommandSpec = configSpec;

  override async run(): Promise<void> {
    await this.runEffect(configSpec);
  }
}
