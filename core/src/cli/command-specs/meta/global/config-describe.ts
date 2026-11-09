import { type ConfigDescribeResult, ConfigDescribeResultSchema } from "@lando/engine/config-write/key-schema";
import type { Effect } from "effect";
import { renderConfigKeyDescription } from "../../../commands/config-key-render";
import { describeGlobalConfig } from "../../../commands/meta/global-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args } from "../../../spec/metadata";
import { formatFlag } from "../../config-flags";
import { globalConfigOptionsFromInput } from "./config";

export const metaGlobalConfigDescribeSpec: LandoCommandSpec<
  ConfigDescribeResult,
  Effect.Error<ReturnType<typeof describeGlobalConfig>>,
  never
> = {
  id: "meta:global:config:describe",
  summary: "Describe accepted values for a global Landofile key.",
  namespace: "meta",
  topLevelAlias: "global:config:describe",
  bootstrap: "none",
  resultSchema: ConfigDescribeResultSchema,
  resultFormats: ["table"],
  args: { key: Args.string({ description: "Dot-path key; omit to list root keys.", required: false }) },
  flags: { format: formatFlag },
  run: (input) => describeGlobalConfig(globalConfigOptionsFromInput(input)),
  render: (result) => renderConfigKeyDescription(result, "Global Landofile"),
};
