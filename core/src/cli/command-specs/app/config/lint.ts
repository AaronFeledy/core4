import { Flags } from "../../../spec/metadata";

import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { ConfigLintResult } from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";
import type { Effect } from "effect";
import { renderConfigLintResult } from "../../../commands/app-config-lint";
import { isEnvelopeResultFormat } from "../../../format-flags";
import type { LandoCommandSpec } from "../../../spec/command-base";

const usesEnvelopeFormat = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "flags" in input &&
  typeof input.flags === "object" &&
  input.flags !== null &&
  "format" in input.flags &&
  typeof input.flags.format === "string" &&
  isEnvelopeResultFormat(input.flags.format);

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
      default: "text",
    }),
  },
  run: () => appConfigLint(),
  successExitCode: (result, input) => (result.valid || usesEnvelopeFormat(input) ? undefined : 1),
  render: (result) => renderConfigLintResult(result as ConfigLintResult, "text"),
};
