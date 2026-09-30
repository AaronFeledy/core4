import { Args, Flags } from "../../../spec/metadata";

import {
  PLUGIN_NEW_TEMPLATE_IDS,
  type PluginNewResult,
  PluginNewResultSchema,
} from "@lando/engine/operations/plugin-scaffold";

import { pluginNew, renderPluginNewResult } from "../../../commands/plugin-new";
import { resolveNonInteractive } from "../../../prompts/answer-flags";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf, specFlagsOf, stringFlag } from "../../../spec/input-coercion";

const extractInput = (input: unknown) => {
  const args = specArgsOf(input);
  const flags = specFlagsOf(input);
  const arrayFlag = (name: string): ReadonlyArray<string> | undefined =>
    Array.isArray(flags[name]) && flags[name].every((entry) => typeof entry === "string")
      ? (flags[name] as ReadonlyArray<string>)
      : undefined;
  return {
    name: stringFlag(args, "name"),
    destination: stringFlag(args, "destination"),
    template: stringFlag(flags, "template"),
    cspace: stringFlag(flags, "cspace"),
    description: stringFlag(flags, "description"),
    answers: arrayFlag("answer"),
    answersFile: stringFlag(flags, "answers"),
    nonInteractive: resolveNonInteractive({
      noInteractive: flags["no-interactive"] === true,
      isTTY: process.stdin.isTTY,
    }),
  };
};

export const pluginNewSpec: LandoCommandSpec<PluginNewResult> = {
  resultSchema: PluginNewResultSchema,
  id: "meta:plugin:new",
  summary: "Scaffold a new plugin from a built-in template (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  args: {
    name: Args.string({ description: "New plugin package name.", required: false }),
    destination: Args.string({ description: "Destination directory.", required: false }),
  },
  flags: {
    template: Flags.string({
      description: "Bundled plugin template id.",
      options: [...PLUGIN_NEW_TEMPLATE_IDS],
    }),
    cspace: Flags.string({ description: "Contribution namespace used by the scaffold." }),
    description: Flags.string({ description: "Plugin description." }),
    answer: Flags.string({ description: "Scaffold answer in key=value form (repeatable).", multiple: true }),
    answers: Flags.string({ description: "Path to a JSON answers file." }),
    "no-interactive": Flags.boolean({
      description: "Never prompt; name, template, cspace, and description must be supplied.",
      default: false,
    }),
  },
  run: (input) => pluginNew(extractInput(input)),
  render: (result) => renderPluginNewResult(result as PluginNewResult),
};
