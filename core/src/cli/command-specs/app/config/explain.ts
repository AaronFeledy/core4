import { Flags } from "../../../spec/metadata";

import {
  type AppConfigExplainResult,
  AppConfigExplainResultSchema,
  appConfigExplain,
  renderAppConfigExplainResult,
} from "../../../commands/app-config-explain";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appConfigExplainSpec: LandoCommandSpec<AppConfigExplainResult> = {
  resultSchema: AppConfigExplainResultSchema,
  id: "app:config:explain",
  summary: "Report recipe provenance and which generated value sites are still managed.",
  namespace: "app",
  topLevelAlias: false,
  aliases: ["config:explain"],
  // Reads and parses one Landofile. No translator, planner, or provider is involved.
  bootstrap: "minimal",
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  },
  run: () => appConfigExplain(),
  render: (result) => renderAppConfigExplainResult(result as AppConfigExplainResult),
};
