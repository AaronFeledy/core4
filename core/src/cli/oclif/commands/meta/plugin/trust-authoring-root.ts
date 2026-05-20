import { Args } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const pluginTrustAuthoringRootSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:trust-authoring-root",
  summary: "Authorize an absolute path as a plugin authoring root (Phase 4 RC deliverable).",
  namespace: "meta",
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:trust-authoring-root"),
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
