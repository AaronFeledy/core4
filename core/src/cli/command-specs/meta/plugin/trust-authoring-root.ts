import { Args } from "../../../spec/metadata";

import {
  type PluginTrustAuthoringRootResult,
  PluginTrustAuthoringRootResultSchema,
  pluginTrustAuthoringRoot,
  renderPluginTrustAuthoringRootResult,
} from "../../../commands/plugin-trust";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf, stringFlag } from "../../../spec/input-coercion";

const extractInput = (input: unknown): { path: string } => {
  return { path: stringFlag(specArgsOf(input), "path") ?? "" };
};

export const pluginTrustAuthoringRootSpec: LandoCommandSpec<PluginTrustAuthoringRootResult> = {
  resultSchema: PluginTrustAuthoringRootResultSchema,
  id: "meta:plugin:trust-authoring-root",
  summary: "Authorize an absolute path as a plugin authoring root.",
  namespace: "meta",
  bootstrap: "minimal",
  args: {
    path: Args.string({ description: "Absolute path to mark as a trusted authoring root.", required: true }),
  },
  run: (input) => pluginTrustAuthoringRoot(extractInput(input)),
  render: (result) => renderPluginTrustAuthoringRootResult(result as PluginTrustAuthoringRootResult),
};
