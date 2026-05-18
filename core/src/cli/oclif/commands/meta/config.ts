import { Args, Flags } from "@oclif/core";

import {
  type ConfigOptions,
  type ConfigResult,
  config,
  renderConfigResult,
} from "../../../commands/config.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const isSubcommand = (s: unknown): s is ConfigOptions["subcommand"] =>
  s === "view" ||
  s === "get" ||
  s === "set" ||
  s === "unset" ||
  s === "edit" ||
  s === "validate" ||
  s === "translate";

const extractOptions = (input: unknown): ConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const i = input as { args?: Record<string, unknown>; flags?: Record<string, unknown> };
  const subcommand = i.args?.subcommand;
  const key = i.args?.key;
  const value = i.args?.value;
  const format = i.flags?.format;
  const path = i.flags?.path;
  const opts: {
    subcommand?: ConfigOptions["subcommand"];
    key?: string;
    value?: string;
    format?: "json" | "yaml" | "table";
    path?: string;
  } = {};
  if (isSubcommand(subcommand)) opts.subcommand = subcommand;
  if (typeof key === "string") opts.key = key;
  if (typeof value === "string") opts.value = value;
  if (format === "json" || format === "yaml" || format === "table") opts.format = format;
  if (typeof path === "string") opts.path = path;
  return opts as ConfigOptions;
};

export const metaConfigSpec: LandoCommandSpec<ConfigResult> = {
  id: "meta:config",
  summary: "Read or write the global Lando config (view/get; write ops are deferred to Beta).",
  namespace: "meta",
  topLevelAlias: "config",
  bootstrap: "minimal",
  run: (input) => config(extractOptions(input)),
  render: (result) => renderConfigResult(result as ConfigResult),
};

export default class MetaConfigCommand extends LandoCommandBase {
  static override description = metaConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaConfigSpec)];
  static override strict = false;
  static override args = {
    subcommand: Args.string({
      description: "Subcommand: view (default), get, set, unset, edit, validate, translate.",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for get/set/unset.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  };
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["json", "yaml", "table"],
      default: "table",
    }),
    path: Flags.string({ description: "Dot-path key selector." }),
  };
  static override landoSpec: LandoCommandSpec = metaConfigSpec;
  static override bootstrap = metaConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaConfigSpec);
  }
}
