import { Args } from "@oclif/core";

import {
  type PluginUnlinkResult,
  pluginUnlink,
  renderPluginUnlinkResult,
} from "../../../../commands/plugin-unlink.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractName = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return typeof args.name === "string" ? args.name : "";
};

export const pluginUnlinkSpec: LandoCommandSpec<PluginUnlinkResult> = {
  id: "meta:plugin:unlink",
  summary: "Remove a previously linked plugin (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: (input) => pluginUnlink({ name: extractName(input) }),
  render: (result) => renderPluginUnlinkResult(result as PluginUnlinkResult),
};

export default class PluginUnlinkCommand extends LandoCommandBase {
  static override description = pluginUnlinkSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginUnlinkSpec)];
  static override args = {
    name: Args.string({ description: "Plugin name.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginUnlinkSpec;
  static override bootstrap = pluginUnlinkSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginUnlinkSpec);
  }
}
