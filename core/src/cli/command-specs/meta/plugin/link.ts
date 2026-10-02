import { Args } from "../../../spec/metadata";

import {
  type PluginLinkResult,
  PluginLinkResultSchema,
  pluginLink,
  renderPluginLinkResult,
} from "../../../commands/plugin-link";

import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf, stringFlag } from "../../../spec/input-coercion";

const extractInput = (input: unknown): { path?: string } => {
  const path = stringFlag(specArgsOf(input), "path");
  return path === undefined ? {} : { path };
};

export const pluginLinkSpec: LandoCommandSpec<PluginLinkResult> = {
  resultSchema: PluginLinkResultSchema,
  id: "meta:plugin:link",
  summary: "Symlink the current plugin into the user-global plugin store (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  args: {
    path: Args.string({
      description: "Plugin authoring directory to link (defaults to cwd).",
      required: false,
    }),
  },
  run: (input) => pluginLink(extractInput(input)),
  render: (result) => renderPluginLinkResult(result as PluginLinkResult),
};
