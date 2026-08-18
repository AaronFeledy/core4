import { Args, Flags } from "../../../spec/metadata";

import {
  type AppConfigResult,
  AppConfigResultSchema,
  type AppConfigSubcommand,
  appConfig,
  renderAppConfigResult,
} from "../../../commands/app-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { appConfigOptionsFromInput } from "./";

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
  subcommand: AppConfigSubcommand,
  summary: string,
  metadata: Pick<LandoCommandSpec, "args" | "flags">,
): LandoCommandSpec<AppConfigResult> => ({
  resultSchema: AppConfigResultSchema,
  id: `app:config:${subcommand}`,
  summary,
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  ...metadata,
  run: (input) => appConfig({ ...appConfigOptionsFromInput(input), subcommand }),
  render: (result, input) =>
    renderAppConfigResult(result as AppConfigResult, appConfigOptionsFromInput(input).format ?? "table"),
});

export const appConfigSetSpec = makeSpec("set", "Set a value in the app's Landofile.", {
  args: {
    key: Args.string({ description: "Dot-path key.", required: true }),
    value: Args.string({ description: "Value to set.", required: true }),
  },
  flags: { type: typeFlag, format: formatFlag, "dry-run": dryRunFlag },
});
export const appConfigUnsetSpec = makeSpec("unset", "Remove a key from the app's Landofile.", {
  args: { key: Args.string({ description: "Dot-path key.", required: true }) },
  flags: { format: formatFlag, "dry-run": dryRunFlag },
});
export const appConfigEditSpec = makeSpec("edit", "Edit the app's Landofile in $EDITOR.", {
  flags: { editor: editorFlag, format: formatFlag },
});
export const appConfigValidateSpec = makeSpec(
  "validate",
  "Validate the app's Landofile against the schema.",
  { flags: { format: formatFlag } },
);
