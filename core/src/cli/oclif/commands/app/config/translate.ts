import { Flags } from "@oclif/core";

import {
  type AppConfigTranslateResult,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../../../commands/app-config-translate.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

export const appConfigTranslateSpec: LandoCommandSpec<AppConfigTranslateResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:config:translate",
  summary: "Translate a non-canonical config file into a canonical v4 Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => appConfigTranslate(),
  render: (result, _input, ctx) =>
    renderConfigTranslateResult(result as AppConfigTranslateResult, ctx?.format === "json" ? "json" : "text"),
};

export default class AppConfigTranslateCommand extends LandoCommandBase {
  static override description = appConfigTranslateSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigTranslateSpec)];
  static override flags = {
    write: Flags.boolean({
      description: "Overwrite the input Landofile in place (a .bak backup is kept).",
      default: false,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  };
  static override landoSpec: LandoCommandSpec = appConfigTranslateSpec;
  static override bootstrap = appConfigTranslateSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(AppConfigTranslateCommand)) as {
      readonly flags: { readonly write?: boolean; readonly format?: string };
    };
    const write = parsed.flags.write === true;
    await this.runEffect({
      ...appConfigTranslateSpec,
      run: () => appConfigTranslate({ write }),
    });
  }
}
