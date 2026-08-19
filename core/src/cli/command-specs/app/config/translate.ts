import { Flags } from "../../../spec/metadata";

import {
  type AppConfigTranslateResult,
  AppConfigTranslateResultSchema,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../../commands/app-config-translate";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { extractSpecFlags } from "../../../spec/command-boundary";

export const appConfigTranslateSpec: LandoCommandSpec<AppConfigTranslateResult> = {
  resultSchema: AppConfigTranslateResultSchema,
  id: "app:config:translate",
  summary: "Translate a non-canonical config file into a canonical v4 Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "minimal",
  flags: {
    list: Flags.boolean({
      description: "List installed config translators and their input kinds.",
      default: false,
    }),
    detect: Flags.boolean({
      description: "Detect supported source files without generating a translated Landofile preview.",
      default: false,
    }),
    from: Flags.string({
      description: "Force a specific translator by id instead of autodetecting.",
    }),
    file: Flags.string({
      description: "Translate an explicit source file (repeatable). Scopes translator input.",
      multiple: true,
    }),
    write: Flags.boolean({
      description: "Overwrite the input Landofile in place (a .bak backup is kept).",
      default: false,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["yaml", "table", "json"],
      default: "yaml",
    }),
  },
  run: (input) => {
    const flags = extractSpecFlags(input);
    const files = Array.isArray(flags.file)
      ? flags.file.filter((file): file is string => typeof file === "string")
      : undefined;
    return appConfigTranslate({
      write: flags.write === true,
      list: flags.list === true,
      detect: flags.detect === true,
      ...(typeof flags.from === "string" ? { from: flags.from } : {}),
      ...(files === undefined ? {} : { files }),
    });
  },
  render: (result) => renderConfigTranslateResult(result as AppConfigTranslateResult, "yaml"),
};
