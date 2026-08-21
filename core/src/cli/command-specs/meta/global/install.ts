import { Args, Flags } from "../../../spec/metadata";

import {
  type GlobalInstallOptions,
  type GlobalInstallResult,
  GlobalInstallResultSchema,
  globalInstall,
} from "@lando/engine/operations/global-install";
import { renderGlobalInstallResult } from "../../../commands/meta/global-install";

import type { LandoCommandSpec } from "../../../spec/command-base";

export const globalInstallOptionsFromInput = (input: unknown): GlobalInstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return typeof args.plugin === "string" ? { plugin: args.plugin } : {};
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
    yes: Flags.boolean({
      char: "y",
      description: "Accepted for consistency with `lando setup --yes`. Global install does not prompt.",
      default: false,
    }),
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
