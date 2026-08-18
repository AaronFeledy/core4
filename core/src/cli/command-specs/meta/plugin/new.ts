import { Args, Flags } from "../../../spec/metadata";

import {
  PLUGIN_NEW_TEMPLATE_IDS,
  type PluginNewResult,
  PluginNewResultSchema,
} from "@lando/engine/operations/plugin-scaffold";

import { pluginNew, renderPluginNewResult } from "../../../commands/plugin-new";
import { resolveNonInteractive } from "../../../prompts/answer-flags";
import type { LandoCommandSpec } from "../../../spec/command-base";

const extractInput = (input: unknown) => {
  const parsed =
    typeof input === "object" && input !== null
      ? (input as { args?: Record<string, unknown>; flags?: Record<string, unknown> })
      : {};
  const args = parsed.args ?? {};
  const flags = parsed.flags ?? {};
  const stringFlag = (name: string): string | undefined =>
    typeof flags[name] === "string" ? flags[name] : undefined;
  const arrayFlag = (name: string): ReadonlyArray<string> | undefined =>
    Array.isArray(flags[name]) && flags[name].every((entry) => typeof entry === "string")
      ? (flags[name] as ReadonlyArray<string>)
      : undefined;
  return {
    name: typeof args.name === "string" ? args.name : undefined,
    destination: typeof args.destination === "string" ? args.destination : undefined,
    template: stringFlag("template"),
    cspace: stringFlag("cspace"),
    description: stringFlag("description"),
    answers: arrayFlag("answer"),
    answersFile: stringFlag("answers"),
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
