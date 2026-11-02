import { Flags } from "../../../spec/metadata";

import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { ConfigLintResult } from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";
import type { Effect } from "effect";
import { renderConfigLintResult } from "../../../commands/app-config-lint";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appConfigLintSpec: LandoCommandSpec<
  ConfigLintResult,
  Effect.Error<ReturnType<typeof appConfigLint>>,
  PluginRegistry
> = {
  resultSchema: ConfigLintResult,
  id: "app:config:lint",
  summary: "Check Landofile configuration, declared listeners, routes, and event names.",
  namespace: "app",
  topLevelAlias: false,
  aliases: ["config:lint"],
  bootstrap: "plugins",
  flags: {
    format: Flags.string({
      description: "Output format.",
      default: "text",
    }),
  },
  run: () => appConfigLint(),
  completion: (result) => ({ ok: true, exitCode: result.valid ? 0 : 1 }),
  render: (result) => renderConfigLintResult(result, "text"),
};
