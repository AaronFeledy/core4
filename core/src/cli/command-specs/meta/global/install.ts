import { nonPromptingYesFlag } from "../../../spec/confirmation-flag";
import { Args } from "../../../spec/metadata";

import {
  type GlobalInstallOptions,
  type GlobalInstallResult,
  GlobalInstallResultSchema,
  globalInstall,
} from "@lando/engine/operations/global-install";
import { renderGlobalInstallResult } from "../../../commands/meta/global-install";

import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf, stringFlag } from "../../../spec/input-coercion";

export const globalInstallOptionsFromInput = (input: unknown): GlobalInstallOptions => {
  const plugin = stringFlag(specArgsOf(input), "plugin");
  return plugin === undefined ? {} : { plugin };
};

export const metaGlobalInstallSpec: LandoCommandSpec<GlobalInstallResult> = {
  resultSchema: GlobalInstallResultSchema,
  id: "meta:global:install",
  summary: "Materialize the host-level global Lando app Landofile stack.",
  description: "Materialize the host-level global Lando app Landofile stack.",
  namespace: "meta",
  topLevelAlias: "global:install",
  bootstrap: "global",
  flags: {
    yes: nonPromptingYesFlag,
  },
  args: {
    plugin: Args.string({
      description: "Plugin name for future global-service enablement.",
      required: false,
    }),
  },
  run: (input) => globalInstall(globalInstallOptionsFromInput(input)),
  render: (result) => renderGlobalInstallResult(result as GlobalInstallResult),
};
