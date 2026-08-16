import { Flags } from "../../spec/metadata";

import {
  type DiscoveredApp,
  type UninstallOptions,
  type UninstallResult,
  UninstallResultSchema,
  uninstall,
} from "@lando/engine/operations/uninstall";
import { renderUninstallResult } from "../../commands/uninstall";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../spec/command-base";

const makeListDiscoveredApps = (): ((
  userDataRoot: string,
  userCacheRoot: string,
) => Promise<ReadonlyArray<DiscoveredApp>>) => {
  return async (userDataRoot: string, userCacheRoot: string): Promise<ReadonlyArray<DiscoveredApp>> => {
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      
      const providersRoot = join(userDataRoot, "providers");
      const apps: DiscoveredApp[] = [];
      
      // Read apps from provider-docker
      try {
        const dockerAppsDir = join(providersRoot, "provider-docker", "apps");
        const entries = await readdir(dockerAppsDir);
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          try {
            const content = await readFile(join(dockerAppsDir, entry), "utf8");
            const envelope = JSON.parse(content) as { plan?: { id?: string; name?: string; root?: string; services?: Record<string, unknown> } };
            if (envelope.plan?.id && envelope.plan.root && envelope.plan.services) {
              apps.push({
                appId: envelope.plan.id,
                appName: envelope.plan.name ?? envelope.plan.id,
                providerId: "docker",
                appRoot: envelope.plan.root,
                services: Object.keys(envelope.plan.services),
              });
            }
          } catch {
            // Skip corrupt files
          }
        }
      } catch {
        // Skip if directory doesn't exist
      }
      
      // Read apps from provider-lando (Podman)
      try {
        const landoAppsDir = join(providersRoot, "provider-lando", "apps");
        const entries = await readdir(landoAppsDir);
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          try {
            const content = await readFile(join(landoAppsDir, entry), "utf8");
            const envelope = JSON.parse(content) as { plan?: { id?: string; name?: string; root?: string; services?: Record<string, unknown> } };
            if (envelope.plan?.id && envelope.plan.root && envelope.plan.services) {
              apps.push({
                appId: envelope.plan.id,
                appName: envelope.plan.name ?? envelope.plan.id,
                providerId: "lando",
                appRoot: envelope.plan.root,
                services: Object.keys(envelope.plan.services),
              });
            }
          } catch {
            // Skip corrupt files
          }
        }
      } catch {
        // Skip if directory doesn't exist
      }
      
      return apps;
    } catch {
      return [];
    }
  };
};

export const uninstallOptionsFromInput = (input: unknown): UninstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { readonly flags?: Record<string, unknown> }).flags ?? {};
  const extra = input as {
    readonly _userDataRoot?: unknown;
    readonly _userCacheRoot?: unknown;
    readonly _userConfRoot?: unknown;
    readonly _execPath?: unknown;
    readonly _exists?: unknown;
    readonly _remove?: unknown;
    readonly _readManagedProviderMachine?: unknown;
    readonly _teardownProviderMachines?: unknown;
    readonly _reportFallbackDir?: unknown;
  };
  const purge = flags.purge === true;
  return {
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    keepData: flags["keep-data"] === true && !purge,
    purge,
    listDiscoveredApps: makeListDiscoveredApps(),
    ...(typeof extra._userDataRoot === "string" ? { userDataRoot: extra._userDataRoot } : {}),
    ...(typeof extra._userCacheRoot === "string" ? { userCacheRoot: extra._userCacheRoot } : {}),
    ...(typeof extra._userConfRoot === "string" ? { userConfRoot: extra._userConfRoot } : {}),
    ...(typeof extra._execPath === "string" ? { execPath: extra._execPath } : {}),
    ...(typeof extra._exists === "function" ? { exists: extra._exists as (path: string) => boolean } : {}),
    ...(typeof extra._remove === "function"
      ? { remove: extra._remove as (path: string) => Promise<void> }
      : {}),
    ...(typeof extra._readManagedProviderMachine === "function"
      ? {
          readManagedProviderMachine: extra._readManagedProviderMachine as NonNullable<
            UninstallOptions["readManagedProviderMachine"]
          >,
        }
      : {}),
    ...(typeof extra._teardownProviderMachines === "function"
      ? {
          teardownProviderMachines: extra._teardownProviderMachines as NonNullable<
            UninstallOptions["teardownProviderMachines"]
          >,
        }
      : {}),
    ...(typeof extra._reportFallbackDir === "string" ? { reportFallbackDir: extra._reportFallbackDir } : {}),
  };
};

export const metaUninstallSpec: LandoCommandSpec<UninstallResult, unknown, never> = {
  resultSchema: UninstallResultSchema,
  id: "meta:uninstall",
  summary: "Remove Lando-owned installed files after confirmation.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) => uninstall(uninstallOptionsFromInput(input)),
  successExitCode: (result) => (result.refused || result.failed ? 1 : undefined),
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
