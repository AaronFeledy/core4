import { Flags } from "@oclif/core";

import {
  type UninstallOptions,
  type UninstallResult,
  renderUninstallResult,
  uninstall,
} from "../../../commands/uninstall.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const uninstallOptionsFromInput = (input: unknown): UninstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { readonly flags?: Record<string, unknown> }).flags ?? {};
  const extra = input as {
    readonly _userDataRoot?: unknown;
    readonly _userCacheRoot?: unknown;
    readonly _execPath?: unknown;
    readonly _exists?: unknown;
    readonly _remove?: unknown;
  };
  const purge = flags.purge === true;
  return {
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    keepData: flags["keep-data"] === true && !purge,
    purge,
    ...(typeof extra._userDataRoot === "string" ? { userDataRoot: extra._userDataRoot } : {}),
    ...(typeof extra._userCacheRoot === "string" ? { userCacheRoot: extra._userCacheRoot } : {}),
    ...(typeof extra._execPath === "string" ? { execPath: extra._execPath } : {}),
    ...(typeof extra._exists === "function" ? { exists: extra._exists as (path: string) => boolean } : {}),
    ...(typeof extra._remove === "function"
      ? { remove: extra._remove as (path: string) => Promise<void> }
      : {}),
  };
};

export const metaUninstallSpec: LandoCommandSpec<UninstallResult> = {
  id: "meta:uninstall",
  summary: "Remove Lando-owned installed files after confirmation.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) => uninstall(uninstallOptionsFromInput(input)),
  render: (result, _input, ctx) => renderUninstallResult(result as UninstallResult, ctx),
};

export default class MetaUninstallCommand extends LandoCommandBase {
  static override description = metaUninstallSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaUninstallSpec)];
  static override flags = {
    "dry-run": Flags.boolean({
      description: "Print the uninstall plan without changing the system.",
      default: false,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Confirm destructive uninstall execution after reviewing the plan.",
      default: false,
    }),
    "keep-data": Flags.boolean({
      description: "Remove Lando-owned toolchain files while preserving app data and global state.",
      default: false,
    }),
    purge: Flags.boolean({
      description: "Remove Lando-owned toolchain files and data roots after confirmation.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = metaUninstallSpec;
  static override bootstrap = metaUninstallSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaUninstallSpec);
  }
}
