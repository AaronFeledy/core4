import { Args } from "@oclif/core";

import {
  type PluginLinkResult,
  pluginLink,
  renderPluginLinkResult,
} from "../../../../commands/plugin-link.ts";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

const extractInput = (input: unknown): { path?: string } => {
  if (typeof input !== "object" || input === null) return {};
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return typeof args.path === "string" ? { path: args.path } : {};
};

export const pluginLinkSpec: LandoCommandSpec<PluginLinkResult> = {
  resultSchema: EmptyResultSchema,
  id: "meta:plugin:link",
  summary: "Symlink the current plugin into the user-global plugin store (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: (input) => pluginLink(extractInput(input)),
  render: (result) => renderPluginLinkResult(result as PluginLinkResult),
};

export default class PluginLinkCommand extends LandoCommandBase {
  static override description = pluginLinkSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginLinkSpec)];
  static override args = {
    path: Args.string({
      description: "Plugin authoring directory to link (defaults to cwd).",
      required: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = pluginLinkSpec;
  static override bootstrap = pluginLinkSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginLinkSpec);
  }
}
