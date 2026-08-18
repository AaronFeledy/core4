import { Flags } from "../../spec/metadata";

import {
  type DiscoveredApp,
  type UninstallOptions,
  type UninstallResult,
  UninstallResultSchema,
  uninstall,
} from "@lando/engine/operations/uninstall";
import { renderUninstallResult } from "../../commands/uninstall";
import type { LandoCommandSpec } from "../../spec/command-base";

const CONTAINER_RUNTIMES = [
  { cmd: "docker", providerId: "docker" },
  { cmd: "podman", providerId: "lando" },
] as const;

// core4 apps carry dev.lando.app; com.lando.app covers Lando 3 leftovers.
const LANDO_APP_LABELS = ["dev.lando.app", "com.lando.app"] as const;
const RUNTIME_PROBE_TIMEOUT_MS = 2_000;
const RUNTIME_QUERY_TIMEOUT_MS = 5_000;
const RUNTIME_CLEANUP_TIMEOUT_MS = 60_000;

const makeListDiscoveredApps =
  (): ((userDataRoot: string, userCacheRoot: string) => Promise<ReadonlyArray<DiscoveredApp>>) =>
  async (userDataRoot: string, _userCacheRoot: string): Promise<ReadonlyArray<DiscoveredApp>> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const availableRuntimes: Array<(typeof CONTAINER_RUNTIMES)[number]> = [];
    for (const runtime of CONTAINER_RUNTIMES) {
      try {
        await execFileAsync(runtime.cmd, ["--version"], { timeout: RUNTIME_PROBE_TIMEOUT_MS });
        availableRuntimes.push(runtime);
      } catch {
        // Runtime not installed; only installed runtimes are queried below.
      }
    }
    // Fail closed: with no runtime to ask, running apps cannot be ruled out.
    if (availableRuntimes.length === 0) {
      throw new Error("neither docker nor podman is available to verify running Lando apps");
    }

    const apps: DiscoveredApp[] = [];
    const errors: string[] = [];

    for (const runtime of availableRuntimes) {
      const runningAppIds = new Set<string>();
      for (const label of LANDO_APP_LABELS) {
        try {
          const { stdout } = await execFileAsync(
            runtime.cmd,
            ["ps", "--filter", `label=${label}`, "--format", `{{.Label "${label}"}}`],
            { timeout: RUNTIME_QUERY_TIMEOUT_MS },
          );
          for (const id of stdout.trim().split("\n")) {
            if (id.length > 0) runningAppIds.add(id);
          }
        } catch (cause) {
          errors.push(`${runtime.cmd}: ${cause instanceof Error ? cause.message : String(cause)}`);
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

    // Apps found: report them; a partially failed query cannot un-find them.
    if (apps.length > 0) return apps;

    // Fail closed: a runtime is installed but could not be queried, so a
    // clean state cannot be claimed.
    if (errors.length > 0) {
      throw new Error(`Failed to query container runtimes: ${errors.join("; ")}`);
    }

    return apps;
  };

// Sweeps every installed runtime rather than only the discovered apps:
// leftover stopped containers, networks, and volumes must go too (#771).
const makeCleanupDiscoveredApps =
  (): ((apps: ReadonlyArray<DiscoveredApp>) => Promise<void>) =>
  async (_apps: ReadonlyArray<DiscoveredApp>): Promise<void> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const errors: string[] = [];

    for (const runtime of CONTAINER_RUNTIMES) {
      try {
        await execFileAsync(runtime.cmd, ["--version"], { timeout: RUNTIME_PROBE_TIMEOUT_MS });
      } catch {
        // Runtime not installed; nothing to sweep.
        continue;
      }

      // Stop and remove every Lando-labeled container, running or stopped.
      for (const label of LANDO_APP_LABELS) {
        try {
          const { stdout } = await execFileAsync(
            runtime.cmd,
            ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.ID}}"],
            { timeout: RUNTIME_QUERY_TIMEOUT_MS },
          );
          const containerIds = stdout
            .trim()
            .split("\n")
            .filter((id) => id.length > 0);
          if (containerIds.length === 0) continue;

          try {
            await execFileAsync(runtime.cmd, ["stop", ...containerIds], {
              timeout: RUNTIME_CLEANUP_TIMEOUT_MS,
            });
          } catch {
            // Containers may already be stopped; forced removal below is the real gate.
          }
          await execFileAsync(runtime.cmd, ["rm", "-f", ...containerIds], {
            timeout: RUNTIME_CLEANUP_TIMEOUT_MS,
          });
        } catch (cause) {
          errors.push(`${runtime.cmd} (${label}): ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      // Prune unused Lando networks and volumes; best-effort.
      try {
        await execFileAsync(
          runtime.cmd,
          ["network", "prune", "-f", "--filter", "label=dev.lando.network=true"],
          { timeout: RUNTIME_CLEANUP_TIMEOUT_MS },
        );
      } catch {
        // Networks still attached to containers are skipped by prune anyway.
      }
      try {
        await execFileAsync(
          runtime.cmd,
          ["volume", "prune", "-f", "--filter", "label=dev.lando.volume=true"],
          { timeout: RUNTIME_CLEANUP_TIMEOUT_MS },
        );
      } catch {
        // Volumes still in use are skipped by prune anyway.
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
  const hasInjectedDiscovery = typeof extra._listDiscoveredApps === "function";
  const listDiscoveredApps = hasInjectedDiscovery
    ? (extra._listDiscoveredApps as NonNullable<UninstallOptions["listDiscoveredApps"]>)
    : makeListDiscoveredApps();
  // Injected discovery without injected cleanup must not fall through to the
  // real container-sweeping cleanup: tests would touch the host runtime.
  const cleanupDiscoveredApps =
    typeof extra._cleanupDiscoveredApps === "function"
      ? (extra._cleanupDiscoveredApps as NonNullable<UninstallOptions["cleanupDiscoveredApps"]>)
      : hasInjectedDiscovery
        ? undefined
        : makeCleanupDiscoveredApps();
  return {
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    keepData: flags["keep-data"] === true && !purge,
    purge,
    listDiscoveredApps,
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
  description: "Remove Lando-owned installed files after confirmation.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  flags: {
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
  },
  run: (input) => uninstall(uninstallOptionsFromInput(input)),
  successExitCode: (result) => (result.refused || result.failed ? 1 : undefined),
  render: (result, _input, ctx) => renderUninstallResult(result as UninstallResult, ctx),
};
