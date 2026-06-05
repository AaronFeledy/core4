import { Args } from "@oclif/core";

import {
  type PluginTrustResult,
  pluginTrust,
  renderPluginTrustResult,
} from "../../../../commands/plugin-trust.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractInput = (input: unknown): { name: string } => {
  if (typeof input !== "object" || input === null) return { name: "" };
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return { name: typeof args.name === "string" ? args.name : "" };
};

export const pluginTrustSpec: LandoCommandSpec<PluginTrustResult> = {
  id: "meta:plugin:trust",
  summary: "Trust an installed plugin.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) => pluginTrust(extractInput(input)),
  render: (result) => renderPluginTrustResult(result as PluginTrustResult),
};

export default class PluginTrustCommand extends LandoCommandBase {
  static override description = pluginTrustSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginTrustSpec)];
  static override args = {
    name: Args.string({ description: "Plugin name.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginTrustSpec;
  static override bootstrap = pluginTrustSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginTrustSpec);
  }
}
