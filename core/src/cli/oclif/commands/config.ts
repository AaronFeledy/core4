import { type ConfigResult, config } from "../../commands/config.ts";
/**
 * `lando config` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const configSpec: LandoCommandSpec<ConfigResult> = {
  id: "config",
  summary: "Read or write the Lando global config.",
  bootstrap: "plugins",
  run: () => config(),
};

export default class ConfigCommand extends LandoCommandBase {
  static override description = configSpec.summary;
  static override landoSpec: LandoCommandSpec = configSpec;

  override async run(): Promise<void> {
    await this.runEffect(configSpec);
  }
}
