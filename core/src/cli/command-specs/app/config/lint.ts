import { Flags } from "../../../spec/metadata";

import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { ConfigLintResult } from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";
import type { Effect } from "effect";
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

export const appConfigLintSpec: LandoCommandSpec<
  ConfigLintResult,
  Effect.Effect.Error<ReturnType<typeof appConfigLint>>,
  PluginRegistry
> = {
  resultSchema: ConfigLintResult,
  id: "app:config:lint",
  summary: "Validate the current app's Landofile schema and resolved event names.",
  namespace: "app",
  topLevelAlias: false,
  aliases: ["config:lint"],
  bootstrap: "plugins",
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
