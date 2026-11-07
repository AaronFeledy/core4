import { type ConfigDescribeResult, ConfigDescribeResultSchema } from "@lando/engine/config-write/key-schema";
import type { Effect } from "effect";
import { describeAppConfig } from "../../../commands/app-config";
import { renderConfigKeyDescription } from "../../../commands/config-key-render";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args } from "../../../spec/metadata";
import { formatFlag } from "../../config-flags";
import { appConfigOptionsFromInput } from "./";

export const appConfigDescribeSpec: LandoCommandSpec<
  ConfigDescribeResult,
  Effect.Error<ReturnType<typeof describeAppConfig>>,
  never
> = {
  id: "app:config:describe",
  summary: "Describe accepted values for a Landofile key.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "none",
  mcpAllowed: true,
  resultSchema: ConfigDescribeResultSchema,
  resultFormats: ["table"],
  args: { key: Args.string({ description: "Dot-path key; omit to list root keys.", required: false }) },
  flags: { format: formatFlag },
  run: (input) => describeAppConfig(appConfigOptionsFromInput(input)),
  render: (result) => renderConfigKeyDescription(result, "Landofile"),
};
