import { specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { Args, Flags } from "../../spec/metadata";

import {
  type ConfigOptions,
  type ConfigResult,
  ConfigResultSchema,
  config,
} from "@lando/engine/operations/config";

import { createDefaultEditorRunner } from "../../../recipes/prompts/editor-command";
import { renderConfigResult } from "../../commands/config";
import { configRedactionTokens } from "../../commands/config-redaction.ts";
import type { LandoCommandSpec } from "../../spec/command-base";
import { dryRunFlag, editorFlag, formatFlag, pathFlag, typeFlag } from "../config-flags";
import { configWriteOptionsFromInput } from "../config-write-input";

export const metaConfigOptionsFromInput = (input: unknown): ConfigOptions => {
  if (typeof input !== "object" || input === null) return {};
  const parsed = configWriteOptionsFromInput(input, { formats: ["json", "yaml", "table"] });
  const source = stringFlag(specFlagsOf(input), "source");
  const opts = {
    ...parsed,
    ...(source === "raw" || source === "resolved" ? { source } : {}),
    editorRunner:
      parsed.editor === undefined
        ? createDefaultEditorRunner()
        : createDefaultEditorRunner({
            env: { ...process.env, EDITOR: parsed.editor, VISUAL: parsed.editor },
          }),
  };
  return opts as ConfigOptions;
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
      description: "Subcommand: view (default), get, set, unset, edit, validate, translate.",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for get/set/unset.", required: false }),
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
  run: (input) => config(metaConfigOptionsFromInput(input)),
  render: (result) => renderConfigResult(result as ConfigResult),
};
