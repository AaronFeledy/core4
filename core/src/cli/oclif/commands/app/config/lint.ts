import { Flags } from "@oclif/core";

import type { ConfigLintResult } from "@lando/sdk/schema";
import { appConfigLint, renderConfigLintResult } from "../../../../commands/app-config-lint.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

export const appConfigLintSpec: LandoCommandSpec<ConfigLintResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:config:lint",
  summary: "Validate the current app's Landofile against the canonical schema.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => appConfigLint(),
  render: (result, _input, ctx) =>
    renderConfigLintResult(result as ConfigLintResult, ctx?.format === "json" ? "json" : "text"),
};

export default class AppConfigLintCommand extends LandoCommandBase {
  static override description = appConfigLintSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigLintSpec)];
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  };
  static override landoSpec: LandoCommandSpec = appConfigLintSpec;
  static override bootstrap = appConfigLintSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appConfigLintSpec);
  }
}
