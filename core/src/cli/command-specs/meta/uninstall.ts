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

const makeListDiscoveredApps =
  (): ((userDataRoot: string, userCacheRoot: string) => Promise<ReadonlyArray<DiscoveredApp>>) | undefined => {
    // Check if any container runtime is available before returning a discovery function
    const { execFileSync } = require("node:child_process");
    let hasAnyRuntime = false;
    for (const cmd of ["podman", "docker"]) {
      try {
        execFileSync(cmd, ["--version"], { stdio: "ignore" });
        hasAnyRuntime = true;
        break;
      } catch {
        // Runtime not available, try next
      }
    }
    
    // If no runtime is available, return undefined to signal discovery is unavailable
    if (!hasAnyRuntime) {
      return undefined;
    }
    
    return async (userDataRoot: string, _userCacheRoot: string): Promise<ReadonlyArray<DiscoveredApp>> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const apps: DiscoveredApp[] = [];
    const runtimes = [
      { cmd: "docker", providerId: "docker" as const },
      { cmd: "podman", providerId: "lando" as const },
    ];

    const QUERY_TIMEOUT_MS = 1000;
    const errors: string[] = [];

    for (const runtime of runtimes) {
      // Query for core4 label (dev.lando.app) and Lando 3 compat (com.lando.app)
      const labels = ["dev.lando.app", "com.lando.app"];
      const runningAppIds = new Set<string>();

      for (const label of labels) {
        try {
          // Race the query against a timeout
          const queryPromise = execFileAsync(runtime.cmd, [
            "ps",
            "--filter",
            `label=${label}`,
            "--format",
            `{{.Label "${label}"}}`,
          ]);

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${runtime.cmd} ps query timed out after ${QUERY_TIMEOUT_MS}ms`)),
              QUERY_TIMEOUT_MS,
            ),
          );

          const { stdout } = await Promise.race([queryPromise, timeoutPromise]);

          const ids = stdout
            .trim()
            .split("\n")
            .filter((id) => id.length > 0);
          for (const id of ids) runningAppIds.add(id);
        } catch (cause) {
          // Collect error - if ALL queries fail we need to surface this
          const error = cause instanceof Error ? cause.message : String(cause);
          errors.push(`${runtime.cmd}: ${error}`);
        }
      }

      if (runningAppIds.size === 0) continue;

      // Load cache details for running apps if available
      const providersRoot = join(userDataRoot, "providers");
      const appsDir = join(providersRoot, `provider-${runtime.providerId}`, "apps");
      const cacheDetails = new Map<string, { name: string; root: string; services: string[] }>();

      try {
        const entries = await readdir(appsDir);
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          try {
            const content = await readFile(join(appsDir, entry), "utf8");
            const envelope = JSON.parse(content) as {
              plan?: { id?: string; name?: string; root?: string; services?: Record<string, unknown> };
            };
            if (envelope.plan?.id && envelope.plan.root && envelope.plan.services) {
              cacheDetails.set(envelope.plan.id, {
                name: envelope.plan.name ?? envelope.plan.id,
                root: envelope.plan.root,
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

      // Report ALL running labeled containers, even without cache
      for (const appId of runningAppIds) {
        const details = cacheDetails.get(appId);
        apps.push({
          appId,
          appName: details?.name ?? appId,
          providerId: runtime.providerId,
          appRoot: details?.root ?? "(unknown)",
          services: details?.services ?? [],
        });
      }
    }

    // If we found apps, return them regardless of errors
    if (apps.length > 0) return apps;

    // If we had errors and found no apps, we cannot be sure - fail closed
    if (errors.length > 0) {
      throw new Error(`Failed to query container runtimes: ${errors.join("; ")}`);
    }

    // No errors and no apps means clean state
    return apps;
  };
  };

const makeCleanupDiscoveredApps =
  (): ((apps: ReadonlyArray<DiscoveredApp>) => Promise<void>) =>
  async (apps: ReadonlyArray<DiscoveredApp>): Promise<void> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Group apps by provider/runtime
    const dockerApps = apps.filter((app) => app.providerId === "docker");
    const podmanApps = apps.filter((app) => app.providerId === "lando");

    const cleanupRuntime = async (cmd: string, appIds: ReadonlyArray<string>) => {
      if (appIds.length === 0) return;

      // Stop and remove containers with Lando labels
      const labels = ["dev.lando.app", "com.lando.app"];
      for (const label of labels) {
        try {
          // List containers with this label
          const { stdout } = await execFileAsync(cmd, [
            "ps",
            "-a",
            "--filter",
            `label=${label}`,
            "--format",
            "{{.ID}}",
          ]);

          const containerIds = stdout
            .trim()
            .split("\n")
            .filter((id) => id.length > 0);

          if (containerIds.length === 0) continue;

          // Stop containers
          try {
            await execFileAsync(cmd, ["stop", ...containerIds]);
          } catch {
            // Continue even if stop fails - containers may already be stopped
          }

          // Remove containers
          await execFileAsync(cmd, ["rm", "-f", ...containerIds]);
        } catch (cause) {
          // If cleanup fails for one label, continue with the next
          const error = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`Failed to clean up ${cmd} containers with label ${label}: ${error}`);
        }
      }

      // Prune unused Lando networks
      try {
        await execFileAsync(cmd, ["network", "prune", "-f", "--filter", "label=dev.lando.network=true"]);
      } catch {
        // Network prune is best-effort
      }

      // Prune unused Lando volumes
      try {
        await execFileAsync(cmd, ["volume", "prune", "-f", "--filter", "label=dev.lando.volume=true"]);
      } catch {
        // Volume prune is best-effort
      }
    };

    const errors: string[] = [];

    if (dockerApps.length > 0) {
      try {
        await cleanupRuntime(
          "docker",
          dockerApps.map((app) => app.appId),
        );
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        errors.push(error);
      }
    }

    if (podmanApps.length > 0) {
      try {
        await cleanupRuntime(
          "podman",
          podmanApps.map((app) => app.appId),
        );
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Container cleanup failed: ${errors.join("; ")}`);
    }
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
    readonly _listDiscoveredApps?: unknown;
    readonly _cleanupDiscoveredApps?: unknown;
  };
  const purge = flags.purge === true;
  const listDiscoveredApps =
    typeof extra._listDiscoveredApps === "function"
      ? (extra._listDiscoveredApps as NonNullable<UninstallOptions["listDiscoveredApps"]>)
      : makeListDiscoveredApps();
  const cleanupDiscoveredApps =
    typeof extra._cleanupDiscoveredApps === "function"
      ? (extra._cleanupDiscoveredApps as NonNullable<UninstallOptions["cleanupDiscoveredApps"]>)
      : makeCleanupDiscoveredApps();
  return {
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    keepData: flags["keep-data"] === true && !purge,
    purge,
    ...(listDiscoveredApps !== undefined ? { listDiscoveredApps } : {}),
    ...(cleanupDiscoveredApps !== undefined ? { cleanupDiscoveredApps } : {}),
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
