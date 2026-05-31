import {
  type GlobalStopResult,
  globalStop,
  renderGlobalStopResult,
} from "../../../../commands/meta/global-stop.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const metaGlobalStopSpec: LandoCommandSpec<GlobalStopResult> = {
  id: "meta:global:stop",
  summary: "Stop the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:stop",
  bootstrap: "global",
  run: () => globalStop(),
  render: (result) => renderGlobalStopResult(result as GlobalStopResult),
};

export default class MetaGlobalStopCommand extends LandoCommandBase {
  static override description = metaGlobalStopSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalStopSpec)];
  static override landoSpec: LandoCommandSpec = metaGlobalStopSpec;
  static override bootstrap = metaGlobalStopSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalStopSpec);
  }
}
