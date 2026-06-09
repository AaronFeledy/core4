import { existsSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import { resolveUserCacheRoot } from "../../cache/paths.ts";
import { resolveUserDataRoot } from "../../config/roots.ts";

export type UninstallStepStatus = "owned" | "user-owned" | "skipped" | "manual";

export interface UninstallPlanStep {
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly destructive: boolean;
  readonly status: UninstallStepStatus;
  readonly detail: string;
}

export interface UninstallOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
  readonly execPath?: string;
  readonly exists?: (path: string) => boolean;
}

export interface UninstallResult {
  readonly dryRun: boolean;
  readonly refused: boolean;
  readonly steps: ReadonlyArray<UninstallPlanStep>;
}

const statusLabel = (status: UninstallStepStatus): string => {
  switch (status) {
    case "owned":
      return "owned by Lando";
    case "user-owned":
      return "user-owned";
    case "manual":
      return "manual remediation";
    case "skipped":
      return "skipped";
  }
};

const pathStatus = (path: string, exists: (path: string) => boolean): UninstallStepStatus =>
  exists(path) ? "owned" : "skipped";

const normalizePathForContainment = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/u, "");

const isWindowsAbsolutePath = (path: string): boolean => /^[A-Za-z]:[\\/]/u.test(path);

const installedBinaryStatus = (execPath: string, userDataRoot: string): UninstallStepStatus => {
  const binDir = normalizePathForContainment(join(userDataRoot, "bin"));
  const binaryPath = normalizePathForContainment(execPath);
  const compareBinDir = isWindowsAbsolutePath(binDir) ? binDir.toLowerCase() : binDir;
  const compareBinaryPath = isWindowsAbsolutePath(binaryPath) ? binaryPath.toLowerCase() : binaryPath;
  return compareBinaryPath.startsWith(`${compareBinDir}/`) ? "owned" : "user-owned";
};

export const buildUninstallPlan = (options: UninstallOptions = {}): ReadonlyArray<UninstallPlanStep> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;

  return [
    {
      id: "managed-provider-runtime",
      label: "managed provider runtime",
      target: join(userDataRoot, "providers", "lando"),
      destructive: true,
      status: pathStatus(join(userDataRoot, "providers", "lando"), exists),
      detail: "Remove Lando-managed runtime bundles when present.",
    },
    {
      id: "managed-provider-machines",
      label: "managed provider machines",
      target: "Lando-managed provider machines",
      destructive: true,
      status: "manual",
      detail: "Provider machine removal requires provider-specific confirmation.",
    },
    {
      id: "mutagen-binary",
      label: "Mutagen binary",
      target: join(userDataRoot, "bin", process.platform === "win32" ? "mutagen.exe" : "mutagen"),
      destructive: true,
      status: pathStatus(
        join(userDataRoot, "bin", process.platform === "win32" ? "mutagen.exe" : "mutagen"),
        exists,
      ),
      detail: "Remove the Lando-downloaded Mutagen host CLI when present.",
    },
    {
      id: "mutagen-agents",
      label: "Mutagen agents",
      target: join(userDataRoot, "bin", "mutagen-agents"),
      destructive: true,
      status: pathStatus(join(userDataRoot, "bin", "mutagen-agents"), exists),
      detail: "Remove Lando-downloaded per-platform Mutagen agents when present.",
    },
    {
      id: "ca-trust",
      label: "CA trust-store changes",
      target: "Lando local CA trust entry",
      destructive: false,
      status: "manual",
      detail: "Review host trust-store entries and remove only Lando-managed certificates.",
    },
    {
      id: "global-app-state",
      label: "global app state",
      target: join(userDataRoot, "global"),
      destructive: true,
      status: pathStatus(join(userDataRoot, "global"), exists),
      detail: "Remove generated global app state when present.",
    },
    {
      id: "caches",
      label: "caches",
      target: userCacheRoot,
      destructive: true,
      status: pathStatus(userCacheRoot, exists),
      detail: "Remove Lando cache data.",
    },
    {
      id: "installed-binary",
      label: "installed binary",
      target: execPath,
      destructive: true,
      status: installedBinaryStatus(execPath, userDataRoot),
      detail: "Remove automatically only when the binary lives in Lando's managed bin directory.",
    },
    {
      id: "shell-entries",
      label: "shell entries",
      target: "Lando shellenv profile block",
      destructive: false,
      status: "manual",
      detail: "Remove clearly delimited Lando shellenv blocks from shell profiles.",
    },
    {
      id: "user-data-root",
      label: "user data root",
      target: userDataRoot,
      destructive: true,
      status: pathStatus(userDataRoot, exists),
      detail: "Remove Lando user data only after reviewing app and global state ownership.",
    },
    {
      id: "user-cache-root",
      label: "user cache root",
      target: userCacheRoot,
      destructive: true,
      status: pathStatus(userCacheRoot, exists),
      detail: "Remove Lando cache root.",
    },
  ];
};

export const uninstall = (options: UninstallOptions = {}): Effect.Effect<UninstallResult> =>
  Effect.sync(() => {
    const dryRun = options.dryRun === true;
    const yes = options.yes === true;
    return {
      dryRun,
      refused: !dryRun && !yes,
      steps: buildUninstallPlan(options),
    };
  });

export const formatUninstallResult = (result: UninstallResult): string => {
  const heading = result.refused
    ? "uninstall refused: destructive execution requires --yes\nuninstall plan"
    : result.dryRun
      ? "uninstall plan (dry-run)"
      : "uninstall plan";
  const lines = result.steps.map((step) => {
    const action = step.destructive ? "destructive" : "non-destructive";
    return `- ${step.label}: ${statusLabel(step.status)} (${action}) — ${step.target}. ${step.detail}`;
  });
  const trailer = result.refused
    ? ["Rerun `lando uninstall --yes` after reviewing this plan."]
    : result.dryRun
      ? ["No changes were made."]
      : ["No changes were made by this preview-only uninstall step."];
  return [heading, ...lines, ...trailer].join("\n");
};

export const renderUninstallResult = (result: UninstallResult): string => {
  if (result.refused) process.exitCode = 1;
  return formatUninstallResult(result);
};
