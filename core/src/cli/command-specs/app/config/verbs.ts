import { Args } from "../../../spec/metadata";

import {
  type AppConfigResult,
  AppConfigResultSchema,
  type AppConfigSubcommand,
  appConfig,
  renderAppConfigResult,
} from "../../../commands/app-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { dryRunFlag, editorFlag, typeFlag } from "../../config-flags";
import { appConfigOptionsFromInput } from "./";

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
  flags: { type: typeFlag, "dry-run": dryRunFlag },
});
export const appConfigUnsetSpec = makeSpec("unset", "Remove a key from the app's Landofile.", {
  args: { key: Args.string({ description: "Dot-path key.", required: true }) },
  flags: { "dry-run": dryRunFlag },
});
export const appConfigEditSpec = makeSpec("edit", "Edit the app's Landofile in $EDITOR.", {
  flags: { editor: editorFlag },
});
export const appConfigValidateSpec = makeSpec(
  "validate",
  "Validate the app's Landofile against the schema.",
  {},
);
