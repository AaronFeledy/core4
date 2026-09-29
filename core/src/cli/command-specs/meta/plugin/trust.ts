import { Args } from "../../../spec/metadata";

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
} from "../../../commands/plugin-trust";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf, stringFlag } from "../../../spec/input-coercion";

const extractInput = (input: unknown): { action: string; name: string } => {
  const args = specArgsOf(input);
  return {
    action: stringFlag(args, "action") ?? "",
    name: stringFlag(args, "name") ?? "",
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
  args: {
    action: Args.string({ description: "Plugin name, list, or revoke.", required: true }),
    name: Args.string({ description: "Plugin name to revoke.", required: false }),
  },
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
