import { Flags } from "@oclif/core";

import {
  type AppConfigTranslateResult,
  AppConfigTranslateResultSchema,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../../../commands/app-config-translate.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appConfigTranslateSpec: LandoCommandSpec<AppConfigTranslateResult> = {
  resultSchema: AppConfigTranslateResultSchema,
  id: "app:config:translate",
  summary: "Translate a non-canonical config file into a canonical v4 Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => appConfigTranslate(),
  render: (result) => renderConfigTranslateResult(result as AppConfigTranslateResult, "yaml"),
};

export default class AppConfigTranslateCommand extends LandoCommandBase {
  static override description = appConfigTranslateSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigTranslateSpec)];
  static override flags = {
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
  };
  static override landoSpec: LandoCommandSpec = appConfigTranslateSpec;
  static override bootstrap = appConfigTranslateSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(AppConfigTranslateCommand)) as {
      readonly flags: {
        readonly write?: boolean;
        readonly list?: boolean;
        readonly detect?: boolean;
        readonly from?: string;
        readonly file?: ReadonlyArray<string>;
        readonly format?: string;
      };
    };
    const { write, list, detect, from, file } = parsed.flags;
    await this.runEffect({
      ...appConfigTranslateSpec,
      run: () =>
        appConfigTranslate({
          write: write === true,
          list: list === true,
          detect: detect === true,
          ...(from === undefined ? {} : { from }),
          ...(file === undefined ? {} : { files: file }),
        }),
    });
  }
}
