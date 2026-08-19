import { Args } from "../../../spec/metadata";

import {
  type PluginUnlinkResult,
  PluginUnlinkResultSchema,
  pluginUnlink,
  renderPluginUnlinkResult,
} from "../../../commands/plugin-unlink";

import type { LandoCommandSpec } from "../../../spec/command-base";

const extractName = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return typeof args.name === "string" ? args.name : "";
};

export const pluginUnlinkSpec: LandoCommandSpec<PluginUnlinkResult> = {
  resultSchema: PluginUnlinkResultSchema,
  id: "meta:plugin:unlink",
  summary: "Remove a previously linked plugin (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  args: {
    name: Args.string({ description: "Plugin name.", required: true }),
  },
  run: (input) => pluginUnlink({ name: extractName(input) }),
  render: (result) => renderPluginUnlinkResult(result as PluginUnlinkResult),
};
