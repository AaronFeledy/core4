import { Args } from "../../../spec/metadata";

import {
  type GlobalConfigOptions,
  type GlobalConfigResult,
  GlobalConfigResultSchema,
  globalConfig,
  renderGlobalConfigResult,
} from "../../../commands/meta/global-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { formatFlag, specFlagsOf } from "../../../spec/input-coercion";
import {
  formatFlag as configFormatFlag,
  dryRunFlag,
  editorFlag,
  pathFlag,
  typeFlag,
} from "../../config-flags";
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
    format: configFormatFlag,
    type: typeFlag,
    path: pathFlag,
    editor: editorFlag,
    "dry-run": dryRunFlag,
  },
  run: (input) => globalConfig(globalConfigOptionsFromInput(input)),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};
