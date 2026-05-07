import { type InfoAppResult, infoApp } from "../../commands/info.ts";
/**
 * `lando info` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const infoSpec: LandoCommandSpec<InfoAppResult> = {
  id: "info",
  summary: "Print provider-neutral runtime info for the current app.",
  bootstrap: "app",
  run: () => infoApp(),
};

export default class InfoCommand extends LandoCommandBase {
  static override description = infoSpec.summary;
  static override landoSpec: LandoCommandSpec = infoSpec;

  override async run(): Promise<void> {
    await this.runEffect(infoSpec);
  }
}
