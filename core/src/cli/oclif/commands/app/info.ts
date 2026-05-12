import { type InfoAppResult, infoApp } from "../../../commands/info.ts";
/**
 * `lando app:info` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const infoSpec: LandoCommandSpec<InfoAppResult> = {
  id: "app:info",
  summary: "Print provider-neutral runtime info for the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => infoApp(),
};

export default class InfoCommand extends LandoCommandBase {
  static override description = infoSpec.summary;
  static override aliases = [...resolveTopLevelAliases(infoSpec)];
  static override landoSpec: LandoCommandSpec = infoSpec;
  static override bootstrap = infoSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(infoSpec);
  }
}
