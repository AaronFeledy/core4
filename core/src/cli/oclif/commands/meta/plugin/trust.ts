import { Args } from "@oclif/core";

import {
  PluginTrustCommandResultSchema,
  type PluginTrustListResult,
  type PluginTrustResult,
  type PluginTrustRevokeResult,
  pluginTrust,
  pluginTrustList,
  pluginTrustRevoke,
  renderPluginTrustListResult,
  renderPluginTrustResult,
  renderPluginTrustRevokeResult,
} from "../../../../commands/plugin-trust.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractInput = (input: unknown): { action: string; name: string } => {
  if (typeof input !== "object" || input === null) return { action: "", name: "" };
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return {
    action: typeof args.action === "string" ? args.action : "",
    name: typeof args.name === "string" ? args.name : "",
  };
};

type PluginTrustCommandResult = PluginTrustResult | PluginTrustListResult | PluginTrustRevokeResult;

export const pluginTrustSpec: LandoCommandSpec<PluginTrustCommandResult> = {
  resultSchema: PluginTrustCommandResultSchema,
  id: "meta:plugin:trust",
  summary: "Manage trusted plugin postinstall entries.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) => {
    const parsed = extractInput(input);
    if (parsed.action === "list") return pluginTrustList();
    if (parsed.action === "revoke") return pluginTrustRevoke({ name: parsed.name });
    return pluginTrust({ name: parsed.action });
  },
  render: (result) => {
    const trustResult = result as PluginTrustCommandResult;
    if (trustResult.kind === "list") return renderPluginTrustListResult(trustResult);
    if (trustResult.kind === "revoke") return renderPluginTrustRevokeResult(trustResult);
    return renderPluginTrustResult(trustResult);
  },
};

export default class PluginTrustCommand extends LandoCommandBase {
  static override description = pluginTrustSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginTrustSpec)];
  static override args = {
    action: Args.string({ description: "Plugin name, list, or revoke.", required: true }),
    name: Args.string({ description: "Plugin name to revoke.", required: false }),
  };
  static override landoSpec: LandoCommandSpec = pluginTrustSpec;
  static override bootstrap = pluginTrustSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginTrustSpec);
  }
}
