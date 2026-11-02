import { makeCleanupDiscoveredApps, makeListDiscoveredApps } from "@lando/engine/install/uninstall-discovery";
import {
  type UninstallOptions,
  type UninstallResult,
  UninstallResultSchema,
  uninstall,
} from "@lando/engine/operations/uninstall";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { renderUninstallResult } from "../../commands/uninstall";
import type { LandoCommandSpec } from "../../spec/command-base";
import { yesFlag } from "../../spec/confirmation-flag";
import { booleanFlag, specFlagsOf } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const uninstallOptionsFromInput = (input: unknown): UninstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = specFlagsOf(input);
  const extra = input as {
    readonly _userDataRoot?: unknown;
    readonly _userCacheRoot?: unknown;
    readonly _userConfRoot?: unknown;
    readonly _exists?: unknown;
    readonly _remove?: unknown;
    readonly _readManagedProviderMachine?: unknown;
    readonly _teardownProviderMachines?: unknown;
    readonly _reportFallbackDir?: unknown;
    readonly _listDiscoveredApps?: unknown;
    readonly _cleanupDiscoveredApps?: unknown;
    readonly _cgroupsDelegatePath?: unknown;
    readonly _shellProfilePath?: unknown;
    readonly _socketProxyUnitPaths?: unknown;
    readonly _socketProxyPolkitPath?: unknown;
    readonly _elevate?: unknown;
    readonly _readText?: unknown;
    readonly _writeText?: unknown;
    readonly _terminateRuntimeBinProcesses?: unknown;
  };
  const purge = booleanFlag(flags, "purge");
  const hasInjectedDiscovery = typeof extra._listDiscoveredApps === "function";
  const listDiscoveredApps = hasInjectedDiscovery
    ? (extra._listDiscoveredApps as NonNullable<UninstallOptions["listDiscoveredApps"]>)
    : makeListDiscoveredApps();
  // Injected discovery must never fall through to real host cleanup.
  const cleanupDiscoveredApps =
    typeof extra._cleanupDiscoveredApps === "function"
      ? (extra._cleanupDiscoveredApps as NonNullable<UninstallOptions["cleanupDiscoveredApps"]>)
      : hasInjectedDiscovery
        ? undefined
        : makeCleanupDiscoveredApps(
            typeof extra._userDataRoot === "string" ? extra._userDataRoot : undefined,
          );
  return {
    dryRun: booleanFlag(flags, "dry-run"),
    yes: booleanFlag(flags, "yes"),
    keepData: booleanFlag(flags, "keep-data") && !purge,
    purge,
    listDiscoveredApps,
    ...(cleanupDiscoveredApps !== undefined ? { cleanupDiscoveredApps } : {}),
    ...(typeof extra._userDataRoot === "string" ? { userDataRoot: extra._userDataRoot } : {}),
    ...(typeof extra._userCacheRoot === "string" ? { userCacheRoot: extra._userCacheRoot } : {}),
    ...(typeof extra._userConfRoot === "string" ? { userConfRoot: extra._userConfRoot } : {}),
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
    ...(typeof extra._cgroupsDelegatePath === "string"
      ? { cgroupsDelegatePath: extra._cgroupsDelegatePath }
      : {}),
    ...(typeof extra._shellProfilePath === "string" ? { shellProfilePath: extra._shellProfilePath } : {}),
    ...(Array.isArray(extra._socketProxyUnitPaths) &&
    extra._socketProxyUnitPaths.every((path) => typeof path === "string")
      ? { socketProxyUnitPaths: extra._socketProxyUnitPaths }
      : {}),
    ...(typeof extra._socketProxyPolkitPath === "string"
      ? { socketProxyPolkitPath: extra._socketProxyPolkitPath }
      : {}),
    ...(typeof extra._elevate === "function"
      ? { elevate: extra._elevate as NonNullable<UninstallOptions["elevate"]> }
      : {}),
    ...(typeof extra._readText === "function"
      ? { readText: extra._readText as (path: string) => string }
      : {}),
    ...(typeof extra._writeText === "function"
      ? { writeText: extra._writeText as (path: string, content: string) => Promise<void> | void }
      : {}),
    ...(typeof extra._terminateRuntimeBinProcesses === "function"
      ? {
          terminateRuntimeBinProcesses: extra._terminateRuntimeBinProcesses as NonNullable<
            UninstallOptions["terminateRuntimeBinProcesses"]
          >,
        }
      : {}),
  };
};

export const metaUninstallSpec: LandoCommandSpec<UninstallResult, unknown, PrivateFileAccessService> = {
  resultSchema: UninstallResultSchema,
  id: "meta:uninstall",
  summary: "Remove Lando-owned installed files after confirmation.",
  description: "Remove Lando-owned installed files after confirmation.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  flags: {
    "dry-run": Flags.boolean({
      description: "Print the uninstall plan without changing the system.",
      default: false,
    }),
    yes: yesFlag("Confirm destructive uninstall execution after reviewing the plan."),
    "keep-data": Flags.boolean({
      description: "Remove the managed CLI while preserving app data, the managed VM, and runtime tools.",
      default: false,
    }),
    purge: Flags.boolean({
      description:
        "Remove Lando-owned apps, the managed VM, runtime tools, and data roots after confirmation.",
      default: false,
    }),
  },
  run: (input) => uninstall(uninstallOptionsFromInput(input)),
  completion: (result) =>
    result.refused || result.failed ? { ok: false, exitCode: 1 } : { ok: true, exitCode: 0 },
  render: (result, _input, ctx) => renderUninstallResult(result, ctx),
};
