import { Args, Flags } from "@oclif/core";

import {
  type AppConfigOptions,
  type AppConfigResult,
  AppConfigResultSchema,
  appConfig,
  renderAppConfigResult,
} from "../../../../commands/app-config.ts";
import type { ValueType } from "../../../../config-write/write-core.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const isValueType = (s: unknown): s is ValueType =>
  s === "string" || s === "number" || s === "boolean" || s === "json" || s === "yaml";

export const appConfigOptionsFromInput = (input: unknown): AppConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const i = input as { args?: Record<string, unknown>; flags?: Record<string, unknown> };
  const opts: {
    // Widened to `string` (not `AppConfigSubcommand`) so an unrecognized verb
    // reaches `appConfig()` and fails there, instead of being dropped here
    // and silently defaulting to the view path.
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
  const format = i.flags?.format;
  const path = i.flags?.path;
  const editor = i.flags?.editor;
  if (typeof subcommand === "string" && subcommand.length > 0) opts.subcommand = subcommand;
  if (typeof key === "string") opts.key = key;
  if (typeof value === "string") opts.value = value;
  if (isValueType(type)) opts.type = type;
  if (format === "json" || format === "table") opts.format = format;
  if (typeof path === "string") opts.path = path;
  if (i.flags?.["dry-run"] === true) opts.dryRun = true;
  if (typeof editor === "string") opts.editor = editor;
  return opts as AppConfigOptions;
};

export const appConfigSpec: LandoCommandSpec<AppConfigResult> = {
  resultSchema: AppConfigResultSchema,
  id: "app:config",
  summary: "Read or write the current app's Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  run: (input) => appConfig(appConfigOptionsFromInput(input)),
  render: (result, input) => {
    const format = appConfigOptionsFromInput(input).format ?? "table";
    return renderAppConfigResult(result as AppConfigResult, format);
  },
};

export default class AppConfigCommand extends LandoCommandBase {
  static override description = appConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigSpec)];
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
  static override landoSpec: LandoCommandSpec = appConfigSpec;
  static override bootstrap = appConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appConfigSpec);
  }
}
