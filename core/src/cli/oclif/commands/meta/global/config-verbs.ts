import { Args, Flags } from "@oclif/core";

import {
  type GlobalConfigResult,
  GlobalConfigResultSchema,
  type GlobalConfigSubcommand,
  globalConfig,
  renderGlobalConfigResult,
} from "../../../../commands/meta/global-config.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";
import { globalConfigFormatFromInput, globalConfigOptionsFromInput } from "./config.ts";

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

const makeSpec = (
  subcommand: GlobalConfigSubcommand,
  summary: string,
  alias: string,
): LandoCommandSpec<GlobalConfigResult> => ({
  resultSchema: GlobalConfigResultSchema,
  id: `meta:global:config:${subcommand}`,
  summary,
  namespace: "meta",
  topLevelAlias: alias,
  bootstrap: "global",
  run: (input) => globalConfig({ ...globalConfigOptionsFromInput(input), subcommand }),
  render: (result, input) =>
    renderGlobalConfigResult(result as GlobalConfigResult, globalConfigFormatFromInput(input)),
});

export const metaGlobalConfigSetSpec = makeSpec(
  "set",
  "Set a value in the global app's Landofile.",
  "global:config:set",
);
export const metaGlobalConfigUnsetSpec = makeSpec(
  "unset",
  "Remove a key from the global app's Landofile.",
  "global:config:unset",
);
export const metaGlobalConfigEditSpec = makeSpec(
  "edit",
  "Edit the global app's Landofile in $EDITOR.",
  "global:config:edit",
);
export const metaGlobalConfigValidateSpec = makeSpec(
  "validate",
  "Validate the global app's Landofile against the schema.",
  "global:config:validate",
);

export class MetaGlobalConfigSetCommand extends LandoCommandBase {
  static override description = metaGlobalConfigSetSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalConfigSetSpec)];
  static override args = {
    key: Args.string({ description: "Dot-path key.", required: true }),
    value: Args.string({ description: "Value to set.", required: true }),
  };
  static override flags = { type: typeFlag, format: formatFlag, "dry-run": dryRunFlag };
  static override landoSpec: LandoCommandSpec = metaGlobalConfigSetSpec;
  static override bootstrap = metaGlobalConfigSetSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(metaGlobalConfigSetSpec);
  }
}

export class MetaGlobalConfigUnsetCommand extends LandoCommandBase {
  static override description = metaGlobalConfigUnsetSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalConfigUnsetSpec)];
  static override args = { key: Args.string({ description: "Dot-path key.", required: true }) };
  static override flags = { format: formatFlag, "dry-run": dryRunFlag };
  static override landoSpec: LandoCommandSpec = metaGlobalConfigUnsetSpec;
  static override bootstrap = metaGlobalConfigUnsetSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(metaGlobalConfigUnsetSpec);
  }
}

export class MetaGlobalConfigEditCommand extends LandoCommandBase {
  static override description = metaGlobalConfigEditSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalConfigEditSpec)];
  static override flags = { editor: editorFlag, format: formatFlag };
  static override landoSpec: LandoCommandSpec = metaGlobalConfigEditSpec;
  static override bootstrap = metaGlobalConfigEditSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(metaGlobalConfigEditSpec);
  }
}

export class MetaGlobalConfigValidateCommand extends LandoCommandBase {
  static override description = metaGlobalConfigValidateSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalConfigValidateSpec)];
  static override flags = { format: formatFlag };
  static override landoSpec: LandoCommandSpec = metaGlobalConfigValidateSpec;
  static override bootstrap = metaGlobalConfigValidateSpec.bootstrap;
  override async run(): Promise<void> {
    await this.runEffect(metaGlobalConfigValidateSpec);
  }
}
