import { Args, Flags } from "../../../spec/metadata";

import {
  type GlobalConfigOptions,
  type GlobalConfigResult,
  GlobalConfigResultSchema,
  globalConfig,
  renderGlobalConfigResult,
} from "../../../commands/meta/global-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { formatFlag, specFlagsOf } from "../../../spec/input-coercion";
import { configWriteOptionsFromInput } from "../../config-write-input";

export const globalConfigFormatFromInput = (input: unknown): "json" | "table" =>
  formatFlag(specFlagsOf(input), ["json", "table"], "table");

export const globalConfigOptionsFromInput = (input: unknown): GlobalConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const opts = configWriteOptionsFromInput(input, { formats: ["json", "table"], defaultFormat: "table" });
  return opts as GlobalConfigOptions;
};

export const metaGlobalConfigSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  id: "meta:global:config",
  resultFormats: ["table"],
  summary: "Read or write the host-level global Lando app Landofile stack.",
  description: "Read or write the host-level global Lando app Landofile stack.",
  namespace: "meta",
  topLevelAlias: "global:config",
  bootstrap: "global",
  strict: false,
  args: {
    subcommand: Args.string({
      description: "Subcommand: view (default), set, unset, edit, validate.",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for set/unset.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  },
  flags: {
    format: Flags.string({
      description: "Output format.",
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
  run: (input) => globalConfig(globalConfigOptionsFromInput(input)),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};
