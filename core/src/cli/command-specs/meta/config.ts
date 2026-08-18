import { Args, Flags } from "../../spec/metadata";

import {
  type ConfigOptions,
  type ConfigResult,
  ConfigResultSchema,
  config,
} from "@lando/engine/operations/config";

import { createDefaultEditorRunner } from "../../../recipes/prompts/editor-command";
import { renderConfigResult } from "../../commands/config";
import type { LandoCommandSpec } from "../../spec/command-base";

const isValueType = (s: unknown): s is NonNullable<ConfigOptions["type"]> =>
  s === "string" || s === "number" || s === "boolean" || s === "json" || s === "yaml";

export const metaConfigOptionsFromInput = (input: unknown): ConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const i = input as { args?: Record<string, unknown>; flags?: Record<string, unknown> };
  const subcommand = i.args?.subcommand;
  const key = i.args?.key;
  const value = i.args?.value;
  const type = i.flags?.type;
  const format = i.flags?.format;
  const path = i.flags?.path;
  const editor = i.flags?.editor;
  const opts: {
    // Widened to `string` (not `ConfigOptions["subcommand"]`) so an
    // unrecognized verb reaches `config()` and fails there, instead of being
    // dropped here and silently defaulting to the view path.
    subcommand?: string;
    key?: string;
    value?: string;
    type?: ConfigOptions["type"];
    format?: "json" | "yaml" | "table";
    path?: string;
    dryRun?: boolean;
    editor?: string;
    editorRunner?: ConfigOptions["editorRunner"];
  } = {};
  if (typeof subcommand === "string" && subcommand.length > 0) opts.subcommand = subcommand;
  if (typeof key === "string") opts.key = key;
  if (typeof value === "string") opts.value = value;
  if (isValueType(type)) opts.type = type;
  if (format === "json" || format === "yaml" || format === "table") opts.format = format;
  if (typeof path === "string") opts.path = path;
  if (i.flags?.["dry-run"] === true) opts.dryRun = true;
  if (typeof editor === "string") {
    opts.editor = editor;
    opts.editorRunner = createDefaultEditorRunner({
      env: { ...process.env, EDITOR: editor, VISUAL: editor },
    });
  } else {
    opts.editorRunner = createDefaultEditorRunner();
  }
  return opts as ConfigOptions;
};

export const metaConfigSpec: LandoCommandSpec<ConfigResult> = {
  resultSchema: ConfigResultSchema,
  id: "meta:config",
  summary: "Read or write the global Lando config.",
  description: "Read or write the global Lando config.",
  namespace: "meta",
  topLevelAlias: "config",
  bootstrap: "minimal",
  strict: false,
  args: {
    subcommand: Args.string({
      description: "Subcommand: view (default), get, set, unset, edit, validate, translate.",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for get/set/unset.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  },
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["json", "yaml", "table"],
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
  },
  run: (input) => config(metaConfigOptionsFromInput(input)),
  render: (result) => renderConfigResult(result as ConfigResult),
};
