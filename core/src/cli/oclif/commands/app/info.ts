import { type InfoAppResult, infoApp, renderInfoAppResult } from "../../../commands/info.ts";
/**
 * `lando app:info` — OCLIF wrapper.
 */
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

export const infoSpec: LandoCommandSpec<InfoAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:info",
  summary: "Print provider-neutral runtime info for the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => infoApp(),
  render: (result, _input, ctx) => renderInfoAppResult(result as InfoAppResult, ctx),
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
