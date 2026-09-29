import { Args } from "../../../spec/metadata";

import {
  type PluginUnlinkResult,
  PluginUnlinkResultSchema,
  pluginUnlink,
  renderPluginUnlinkResult,
} from "../../../commands/plugin-unlink";

import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf, stringFlag } from "../../../spec/input-coercion";

const extractName = (input: unknown): string => stringFlag(specArgsOf(input), "name") ?? "";

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
