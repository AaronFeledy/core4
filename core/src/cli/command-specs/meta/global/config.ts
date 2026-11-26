import { configRedactionTokens } from "../../../commands/config-redaction";
import {
  GLOBAL_CONFIG_SUBCOMMANDS,
  type GlobalConfigOptions,
  renderGlobalConfigResult,
} from "../../../commands/meta/global-config";
import {
  type GlobalConfigResult,
  GlobalConfigResultSchema,
} from "../../../commands/meta/global-config-result";
import { runGlobalConfig } from "../../../config-command-runtime.ts";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { commandResultFormatAmong } from "../../../spec/input-coercion";
import { Args } from "../../../spec/metadata";
import { dryRunFlag, editorFlag, pathFlag, typeFlag } from "../../config-flags";
import { configWriteOptionsFromInput } from "../../config-write-input";

export const globalConfigFormatFromInput = (input: unknown): "json" | "table" =>
  commandResultFormatAmong(input, ["json", "table"], "table");

export const globalConfigOptionsFromInput = (input: unknown): GlobalConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const opts = configWriteOptionsFromInput(input, { formats: ["json", "table"], defaultFormat: "table" });
  return opts as GlobalConfigOptions;
};

export const metaGlobalConfigSpec: LandoCommandSpec<GlobalConfigResult> = {
  resultSchema: GlobalConfigResultSchema,
  redactionTokens: configRedactionTokens,
  id: "meta:global:config",
  rendersTable: true,
  summary: "Read or write the host-level global Lando app Landofile stack.",
  description: "Read or write the host-level global Lando app Landofile stack.",
  namespace: "meta",
  topLevelAlias: "global:config",
  bootstrap: "plugins",
  strict: false,
  args: {
    subcommand: Args.string({
      options: GLOBAL_CONFIG_SUBCOMMANDS,
      description: "Subcommand to run (default: view).",
      required: false,
    }),
    key: Args.string({ description: "Key selector for get/set/unset/describe.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  },
  flags: {
    type: typeFlag,
    path: pathFlag,
    editor: editorFlag,
    "dry-run": dryRunFlag,
  },
  run: (input) => runGlobalConfig(globalConfigOptionsFromInput(input)),
  render: (result, input) => renderGlobalConfigResult(result, globalConfigFormatFromInput(input)),
};
