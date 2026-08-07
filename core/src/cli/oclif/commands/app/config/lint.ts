import { Flags } from "../../../metadata";

import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { ConfigLintResult } from "@lando/sdk/schema";
import { renderConfigLintResult } from "../../../../commands/app-config-lint";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base";

const usesJsonFormat = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "flags" in input &&
  typeof input.flags === "object" &&
  input.flags !== null &&
  "format" in input.flags &&
  input.flags.format === "json";

export const appConfigLintSpec: LandoCommandSpec<ConfigLintResult> = {
  resultSchema: ConfigLintResult,
  id: "app:config:lint",
  summary: "Validate the current app's Landofile against the canonical schema.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => appConfigLint(),
  successExitCode: (result, input) => (result.valid || usesJsonFormat(input) ? undefined : 1),
  render: (result) => renderConfigLintResult(result as ConfigLintResult, "text"),
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
