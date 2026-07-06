import { Flags } from "@oclif/core";

import {
  AppInfoResultSchema,
  type InfoAppResult,
  infoApp,
  renderInfoAppResult,
} from "../../../commands/info.ts";
/**
 * `lando app:info` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const infoDeepFromInput = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return flags.deep === true;
};

export const infoSpec: LandoCommandSpec<InfoAppResult> = {
  resultSchema: AppInfoResultSchema,
  id: "app:info",
  mcpAllowed: true,
  summary: "Print provider-neutral runtime info for the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: (input) => infoApp({ deep: infoDeepFromInput(input) }),
  render: (result, _input, ctx) => renderInfoAppResult(result as InfoAppResult, ctx),
};

export default class InfoCommand extends LandoCommandBase {
  static override description = infoSpec.summary;
  static override aliases = [...resolveTopLevelAliases(infoSpec)];
  static override flags = {
    deep: Flags.boolean({
      description: "Include the resolved host agent-context env forwarding allowlist.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = infoSpec;
  static override bootstrap = infoSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(infoSpec);
  }
}
