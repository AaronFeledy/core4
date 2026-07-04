import { Args, Flags } from "@oclif/core";

import {
  type AppConfigResult,
  AppConfigResultSchema,
  type AppConfigSubcommand,
  appConfig,
  renderAppConfigResult,
} from "../../../../commands/app-config.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";
import { appConfigOptionsFromInput } from "./index.ts";

const typeFlag = Flags.string({
  description: "Value type for set.",
  options: ["string", "number", "boolean", "json", "yaml"],
  default: "string",
});
const formatFlag = Flags.string({
  description: "Output format.",
  options: ["table", "json"],
  default: "table",
});
const editorFlag = Flags.string({ description: "Editor binary for edit." });
const dryRunFlag = Flags.boolean({ description: "Report the change without writing.", default: false });

const makeSpec = (subcommand: AppConfigSubcommand, summary: string): LandoCommandSpec<AppConfigResult> => ({
  resultSchema: AppConfigResultSchema,
  id: `app:config:${subcommand}`,
  summary,
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  run: (input) => appConfig({ ...appConfigOptionsFromInput(input), subcommand }),
  render: (result, input) =>
    renderAppConfigResult(result as AppConfigResult, appConfigOptionsFromInput(input).format ?? "table"),
});

export const appConfigSetSpec = makeSpec("set", "Set a value in the app's Landofile.");
export const appConfigUnsetSpec = makeSpec("unset", "Remove a key from the app's Landofile.");
export const appConfigEditSpec = makeSpec("edit", "Edit the app's Landofile in $EDITOR.");
export const appConfigValidateSpec = makeSpec("validate", "Validate the app's Landofile against the schema.");

export class AppConfigSetCommand extends LandoCommandBase {
  static override description = appConfigSetSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigSetSpec)];
  static override args = {
    key: Args.string({ description: "Dot-path key.", required: true }),
    value: Args.string({ description: "Value to set.", required: true }),
  };
  static override flags = { type: typeFlag, format: formatFlag, "dry-run": dryRunFlag };
  static override landoSpec: LandoCommandSpec = appConfigSetSpec;
  static override bootstrap = appConfigSetSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(appConfigSetSpec);
  }
}

export class AppConfigUnsetCommand extends LandoCommandBase {
  static override description = appConfigUnsetSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigUnsetSpec)];
  static override args = { key: Args.string({ description: "Dot-path key.", required: true }) };
  static override flags = { format: formatFlag, "dry-run": dryRunFlag };
  static override landoSpec: LandoCommandSpec = appConfigUnsetSpec;
  static override bootstrap = appConfigUnsetSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(appConfigUnsetSpec);
  }
}

export class AppConfigEditCommand extends LandoCommandBase {
  static override description = appConfigEditSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigEditSpec)];
  static override flags = { editor: editorFlag, format: formatFlag };
  static override landoSpec: LandoCommandSpec = appConfigEditSpec;
  static override bootstrap = appConfigEditSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(appConfigEditSpec);
  }
}

export class AppConfigValidateCommand extends LandoCommandBase {
  static override description = appConfigValidateSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigValidateSpec)];
  static override flags = { format: formatFlag };
  static override landoSpec: LandoCommandSpec = appConfigValidateSpec;
  static override bootstrap = appConfigValidateSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(appConfigValidateSpec);
  }
}
