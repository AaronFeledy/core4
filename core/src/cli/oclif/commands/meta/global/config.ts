import { Args, Flags } from "@oclif/core";

import {
  type GlobalConfigOptions,
  type GlobalConfigResult,
  GlobalConfigResultSchema,
  globalConfig,
  renderGlobalConfigResult,
} from "../../../../commands/meta/global-config.ts";
import type { ValueType } from "../../../../config-write/write-core.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const isValueType = (s: unknown): s is ValueType =>
  s === "string" || s === "number" || s === "boolean" || s === "json" || s === "yaml";

export const globalConfigFormatFromInput = (input: unknown): "json" | "table" => {
  if (typeof input !== "object" || input === null) return "table";
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return flags.format === "json" ? "json" : "table";
};

export const globalConfigOptionsFromInput = (input: unknown): GlobalConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const i = input as { args?: Record<string, unknown>; flags?: Record<string, unknown> };
  const opts: {
    // Widened to `string` (not `GlobalConfigSubcommand`) so an unrecognized
    // verb reaches `globalConfig()` and fails there, instead of being
    // dropped here and silently defaulting to the view path.
    subcommand?: string;
    key?: string;
    value?: string;
    type?: ValueType;
    format?: "json" | "table";
    path?: string;
    dryRun?: boolean;
    editor?: string;
  } = {};
  const subcommand = i.args?.subcommand;
  const key = i.args?.key;
  const value = i.args?.value;
  const type = i.flags?.type;
  const path = i.flags?.path;
  const editor = i.flags?.editor;
  if (typeof subcommand === "string" && subcommand.length > 0) opts.subcommand = subcommand;
  if (typeof key === "string") opts.key = key;
  if (typeof value === "string") opts.value = value;
  if (isValueType(type)) opts.type = type;
  opts.format = globalConfigFormatFromInput(input);
  if (typeof path === "string") opts.path = path;
  if (i.flags?.["dry-run"] === true) opts.dryRun = true;
  if (typeof editor === "string") opts.editor = editor;
  return opts as GlobalConfigOptions;
};

export const metaGlobalConfigSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  id: "meta:global:config",
  summary: "Read or write the host-level global Lando app Landofile stack.",
  namespace: "meta",
  topLevelAlias: "global:config",
  bootstrap: "global",
  run: (input) => globalConfig(globalConfigOptionsFromInput(input)),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};

export default class MetaGlobalConfigCommand extends LandoCommandBase {
  static override description = metaGlobalConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalConfigSpec)];
  static override strict = false;
  static override args = {
    subcommand: Args.string({
      description: "Subcommand: view (default), set, unset, edit, validate.",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for set/unset.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  };
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
    type: Flags.string({
      description: "Value type for set.",
      options: ["string", "number", "boolean", "json", "yaml"],
      default: "string",
    }),
    path: Flags.string({ description: "Dot-path key selector." }),
    editor: Flags.string({ description: "Editor binary for edit." }),
    "dry-run": Flags.boolean({ description: "Report the change without writing.", default: false }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalConfigSpec;
  static override bootstrap = metaGlobalConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalConfigSpec);
  }
}
