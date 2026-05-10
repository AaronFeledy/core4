import { type InfoAppResult, infoApp } from "../../../commands/info.ts";
/**
 * SPEC: §8.2 canonical id `app:info`.
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

  override async run(): Promise<void> {
    await this.runEffect(infoSpec);
  }
}
