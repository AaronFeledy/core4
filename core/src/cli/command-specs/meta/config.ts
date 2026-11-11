import {
  CONFIG_SUBCOMMANDS,
  type ConfigResult,
  ConfigResultSchema,
  type MetaConfigOptions,
  runConfig,
} from "@lando/engine/operations/config";
import { Effect } from "effect";
import { createDefaultEditorRunner } from "../../../recipes/prompts/editor-command";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationContext,
} from "../../../runtime/invocation-context";
import { renderConfigResult } from "../../commands/config";
import { configRedactionTokens } from "../../commands/config-redaction.ts";
import type { LandoCommandSpec } from "../../spec/command-base";
import { specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { Args, Flags } from "../../spec/metadata";
import { dryRunFlag, editorFlag, formatFlag, pathFlag, typeFlag } from "../config-flags";
import { configWriteOptionsFromInput } from "../config-write-input";

export const metaConfigOptionsFromInput = (
  input: unknown,
  context: CliInvocationContext = processInvocationContext(),
): MetaConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const parsed = configWriteOptionsFromInput(input, { formats: ["json", "yaml", "table"] });
  const source = stringFlag(specFlagsOf(input), "source");
  const opts = {
    ...parsed,
    ...(source === "raw" || source === "resolved" ? { source } : {}),
    editorRunner:
      parsed.editor === undefined
        ? createDefaultEditorRunner({ env: context.env })
        : createDefaultEditorRunner({
            env: { ...context.env, EDITOR: parsed.editor, VISUAL: parsed.editor },
          }),
  };
  return opts as MetaConfigOptions;
};

export const metaConfigSpec: LandoCommandSpec<ConfigResult> = {
  resultSchema: ConfigResultSchema,
  redactionTokens: configRedactionTokens,
  id: "meta:config",
  resultFormats: ["table"],
  summary: "Read or write the global Lando config.",
  description: "Read or write the global Lando config.",
  namespace: "meta",
  topLevelAlias: "config",
  bootstrap: "none",
  strict: false,
  args: {
    subcommand: Args.string({
      options: CONFIG_SUBCOMMANDS,
      description: "Subcommand to run (default: view).",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for get/set/unset/describe.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  },
  flags: {
    source: Flags.string({
      description: "Inspect raw config.yml or resolved config.",
      options: ["raw", "resolved"],
    }),
    format: formatFlag,
    type: typeFlag,
    path: pathFlag,
    editor: editorFlag,
    "dry-run": dryRunFlag,
  },
  run: Effect.fn("ConfigCommand.run")(function* (input: unknown) {
    return yield* runConfig(metaConfigOptionsFromInput(input, yield* CliInvocation));
  }),
  render: (result) => renderConfigResult(result),
};
