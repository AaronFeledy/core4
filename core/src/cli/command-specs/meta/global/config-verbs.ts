import { Args, Flags } from "../../../spec/metadata";

import {
  type GlobalConfigResult,
  GlobalConfigResultSchema,
  globalConfig,
  renderGlobalConfigResult,
} from "../../../commands/meta/global-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { globalConfigFormatFromInput, globalConfigOptionsFromInput } from "./config";

const typeFlag = Flags.string({
  description: "Value type for set.",
  options: ["string", "number", "boolean", "json", "yaml"],
  default: "string",
});
const formatFlag = Flags.string({
  description: "Output format.",
  options: ["table", "json"],
  default: "table",
});
const editorFlag = Flags.string({ description: "Editor binary for edit." });
const dryRunFlag = Flags.boolean({ description: "Report the change without writing.", default: false });

export const metaGlobalConfigSetSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  id: "meta:global:config:set",
  summary: "Set a value in the global app's Landofile.",
  description: "Set a value in the global app's Landofile.",
  namespace: "meta",
  topLevelAlias: "global:config:set",
  bootstrap: "global",
  args: {
    key: Args.string({ description: "Dot-path key.", required: true }),
    value: Args.string({ description: "Value to set.", required: true }),
  },
  flags: { type: typeFlag, format: formatFlag, "dry-run": dryRunFlag },
  run: (input) => globalConfig({ ...globalConfigOptionsFromInput(input), subcommand: "set" }),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};

export const metaGlobalConfigUnsetSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  id: "meta:global:config:unset",
  summary: "Remove a key from the global app's Landofile.",
  description: "Remove a key from the global app's Landofile.",
  namespace: "meta",
  topLevelAlias: "global:config:unset",
  bootstrap: "global",
  args: {
    key: Args.string({ description: "Dot-path key.", required: true }),
  },
  flags: { format: formatFlag, "dry-run": dryRunFlag },
  run: (input) => globalConfig({ ...globalConfigOptionsFromInput(input), subcommand: "unset" }),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};

export const metaGlobalConfigEditSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  id: "meta:global:config:edit",
  summary: "Edit the global app's Landofile in $EDITOR.",
  description: "Edit the global app's Landofile in $EDITOR.",
  namespace: "meta",
  topLevelAlias: "global:config:edit",
  bootstrap: "global",
  flags: { editor: editorFlag, format: formatFlag },
  run: (input) => globalConfig({ ...globalConfigOptionsFromInput(input), subcommand: "edit" }),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};

export const metaGlobalConfigValidateSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  id: "meta:global:config:validate",
  summary: "Validate the global app's Landofile against the schema.",
  description: "Validate the global app's Landofile against the schema.",
  namespace: "meta",
  topLevelAlias: "global:config:validate",
  bootstrap: "global",
  flags: { format: formatFlag },
  run: (input) => globalConfig({ ...globalConfigOptionsFromInput(input), subcommand: "validate" }),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
};
