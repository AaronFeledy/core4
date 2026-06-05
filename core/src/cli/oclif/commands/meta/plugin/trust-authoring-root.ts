import { Args } from "@oclif/core";

import {
  type PluginTrustAuthoringRootResult,
  pluginTrustAuthoringRoot,
  renderPluginTrustAuthoringRootResult,
} from "../../../../commands/plugin-trust.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

const extractInput = (input: unknown): { path: string } => {
  if (typeof input !== "object" || input === null) return { path: "" };
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return { path: typeof args.path === "string" ? args.path : "" };
};

export const pluginTrustAuthoringRootSpec: LandoCommandSpec<PluginTrustAuthoringRootResult> = {
  id: "meta:plugin:trust-authoring-root",
  summary: "Authorize an absolute path as a plugin authoring root.",
  namespace: "meta",
  bootstrap: "minimal",
  run: (input) => pluginTrustAuthoringRoot(extractInput(input)),
  render: (result) => renderPluginTrustAuthoringRootResult(result as PluginTrustAuthoringRootResult),
};

export default class PluginTrustAuthoringRootCommand extends LandoCommandBase {
  static override description = pluginTrustAuthoringRootSpec.summary;
  static override args = {
    path: Args.string({ description: "Absolute path to mark as a trusted authoring root.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginTrustAuthoringRootSpec;
  static override bootstrap = pluginTrustAuthoringRootSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginTrustAuthoringRootSpec);
  }
}
