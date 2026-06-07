import { Args } from "@oclif/core";
import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

import {
  type PluginRemoveResult,
  pluginRemove,
  renderPluginRemoveResult,
} from "../../../../commands/plugin-remove.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractInput = (input: unknown): { name: string } => {
  if (typeof input !== "object" || input === null) return { name: "" };
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return { name: typeof args.name === "string" ? args.name : "" };
};

export const pluginRemoveSpec: LandoCommandSpec<PluginRemoveResult> = {
  id: "meta:plugin:remove",
  summary: "Remove an installed Lando plugin.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) =>
    Effect.gen(function* () {
      const { name } = extractInput(input);
      if (name === "") {
        return yield* Effect.fail(
          new NotImplementedError({
            message: "meta:plugin:remove requires a plugin name argument.",
            commandId: "meta:plugin:remove",
            remediation: "Pass the plugin name, e.g. `lando plugin:remove @lando/plugin-php`.",
          }),
        );
      }
      return yield* pluginRemove({ name });
    }),
  render: (result) => renderPluginRemoveResult(result as PluginRemoveResult),
};

export default class PluginRemoveCommand extends LandoCommandBase {
  static override description = pluginRemoveSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginRemoveSpec)];
  static override args = {
    name: Args.string({ description: "Plugin name.", required: false }),
  };
  static override landoSpec: LandoCommandSpec = pluginRemoveSpec;
  static override bootstrap = pluginRemoveSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginRemoveSpec);
  }
}
