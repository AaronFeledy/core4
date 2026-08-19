import { Effect } from "effect";
import { Args } from "../../../spec/metadata";

import { NotImplementedError } from "@lando/sdk/errors";

import {
  type PluginRemoveResult,
  PluginRemoveResultSchema,
  pluginRemove,
  renderPluginRemoveResult,
} from "../../../commands/plugin-remove";

import type { LandoCommandSpec } from "../../../spec/command-base";

const extractInput = (input: unknown): { name: string } => {
  if (typeof input !== "object" || input === null) return { name: "" };
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return { name: typeof args.name === "string" ? args.name : "" };
};

export const pluginRemoveSpec: LandoCommandSpec<PluginRemoveResult> = {
  resultSchema: PluginRemoveResultSchema,
  id: "meta:plugin:remove",
  summary: "Remove an installed Lando plugin.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  args: {
    name: Args.string({ description: "Plugin name.", required: false }),
  },
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
