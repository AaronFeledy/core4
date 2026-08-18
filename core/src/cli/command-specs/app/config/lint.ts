import { Flags } from "../../../spec/metadata";

import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { ConfigLintResult } from "@lando/sdk/schema";
import { renderConfigLintResult } from "../../../commands/app-config-lint";
import type { LandoCommandSpec } from "../../../spec/command-base";

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
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  },
  run: () => appConfigLint(),
  successExitCode: (result, input) => (result.valid || usesJsonFormat(input) ? undefined : 1),
  render: (result) => renderConfigLintResult(result as ConfigLintResult, "text"),
};
