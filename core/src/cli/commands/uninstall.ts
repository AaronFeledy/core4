import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Effect } from "effect";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { resolveUserCacheRoot } from "../../cache/paths.ts";
import { makeLandoPaths, normalizeHostPlatform } from "../../config/paths.ts";
import { resolveUserDataRoot } from "../../config/roots.ts";
import {
  buildManagedRuntimeServiceSpec,
  terminateOwnedRuntimeService,
} from "../../runtime/managed-runtime-service.ts";
import type { RenderContext } from "../renderer-boundary.ts";
import { type SummaryDocument, type SummaryTone, formatSummary } from "../renderer/summary.ts";

export type UninstallStepStatus = "owned" | "user-owned" | "skipped" | "manual";
export type UninstallStepOutcome = "completed" | "failed" | "manual" | "skipped";
export type UninstallMode = "keep-data" | "purge";

export interface UninstallPlanStep {
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly destructive: boolean;
  readonly status: UninstallStepStatus;
  readonly detail: string;
  readonly outcome?: UninstallStepOutcome;
  readonly error?: string;
}

export interface UninstallOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly keepData?: boolean;
  readonly purge?: boolean;
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
  readonly execPath?: string;
  readonly exists?: (path: string) => boolean;
  readonly remove?: (path: string) => Promise<void>;
  readonly teardownRuntimeService?: (
    userDataRoot: string,
  ) => Promise<{ readonly terminated: boolean; readonly pid?: number }>;
}

export interface UninstallResult {
  readonly dryRun: boolean;
  readonly refused: boolean;
  readonly mode: UninstallMode;
  readonly failed: boolean;
  readonly reportPath?: string;
  readonly steps: ReadonlyArray<UninstallPlanStep>;
}

export interface UninstallReport {
  readonly status: "completed" | "failed";
  readonly mode: UninstallMode;
  readonly updatedAt: string;
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

const normalizedAbsolutePath = (path: string): string => normalizePathForContainment(resolve(path));

const installedBinaryStatus = (execPath: string, userDataRoot: string): UninstallStepStatus => {
  // Path-shape (not host) drives the column so a Windows-style userDataRoot is
  // contained correctly when this runs on a POSIX host (e.g. tests).
  const rawBinDir = makeLandoPaths({
    userDataRoot,
    platform: isWindowsAbsolutePath(userDataRoot) ? "win32" : normalizeHostPlatform(),
  }).binDir;
  const binDir = isWindowsAbsolutePath(userDataRoot)
    ? normalizePathForContainment(rawBinDir)
    : normalizedAbsolutePath(rawBinDir);
  const binaryPath = isWindowsAbsolutePath(execPath)
    ? normalizePathForContainment(execPath)
    : normalizedAbsolutePath(execPath);
  const compareBinDir = isWindowsAbsolutePath(binDir) ? binDir.toLowerCase() : binDir;
  const compareBinaryPath = isWindowsAbsolutePath(binaryPath) ? binaryPath.toLowerCase() : binaryPath;
  return compareBinaryPath.startsWith(`${compareBinDir}/`) ? "owned" : "user-owned";
};

const keepDataProtectedStepIds = new Set(["global-app-state", "caches", "user-data-root", "user-cache-root"]);

const uninstallReportPath = (userDataRoot: string): string => join(userDataRoot, "uninstall", "report.json");

const defaultRemove = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

const defaultTeardownRuntimeService = (
  userDataRoot: string,
): Promise<{ readonly terminated: boolean; readonly pid?: number }> => {
  const spec = buildManagedRuntimeServiceSpec(makeLandoPaths({ userDataRoot }));
  return Effect.runPromise(terminateOwnedRuntimeService(spec));
};

const outcomeForSkippedStep = (step: UninstallPlanStep): UninstallStepOutcome => {
  if (step.status === "manual" || step.status === "user-owned") return "manual";
  return "skipped";
};

const stepWithMode = (step: UninstallPlanStep, mode: UninstallMode): UninstallPlanStep => {
  if (mode === "keep-data" && keepDataProtectedStepIds.has(step.id)) {
    return {
      ...step,
      status: "skipped",
      detail: "Preserved by --keep-data; rerun with --purge to remove this state.",
    };
  }
  if (step.id === "installed-binary" && step.status === "user-owned") {
    return {
      ...step,
      detail: `Remove ${step.target} manually; it is outside Lando's managed bin directory.`,
    };
  }
  return step;
};

export const buildUninstallPlan = (
  options: UninstallOptions = {},
  mode?: UninstallMode,
): ReadonlyArray<UninstallPlanStep> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const paths = makeLandoPaths({ userDataRoot });
  const runtimeDir = paths.runtimeDir;
  const managedProviderRuntime = join(userDataRoot, "providers", "lando");
  const mutagenBinary = join(paths.binDir, paths.platform === "win32" ? "mutagen.exe" : "mutagen");
  const mutagenAgents = join(paths.binDir, "mutagen-agents");
  const globalAppState = paths.globalAppRoot;

  const steps: ReadonlyArray<UninstallPlanStep> = [
    {
      id: "runtime-service",
      label: "managed runtime service",
      target: runtimeDir,
      destructive: true,
      status: pathStatus(runtimeDir, exists),
      detail:
        "Terminate the Lando-managed runtime service and remove its socket, PID, and runtime directory.",
    },
    {
      id: "managed-provider-runtime",
      label: "managed provider runtime",
      target: managedProviderRuntime,
      destructive: true,
      status: pathStatus(managedProviderRuntime, exists),
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
      target: mutagenBinary,
      destructive: true,
      status: pathStatus(mutagenBinary, exists),
      detail: "Remove the Lando-downloaded Mutagen host CLI when present.",
    },
    {
      id: "mutagen-agents",
      label: "Mutagen agents",
      target: mutagenAgents,
      destructive: true,
      status: pathStatus(mutagenAgents, exists),
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
      target: globalAppState,
      destructive: true,
      status: pathStatus(globalAppState, exists),
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
  return mode === undefined ? steps : steps.map((step) => stepWithMode(step, mode));
};

const writeUninstallReport = (
  userDataRoot: string,
  mode: UninstallMode,
  steps: ReadonlyArray<UninstallPlanStep>,
): Promise<string> => {
  const reportPath = uninstallReportPath(userDataRoot);
  const report: UninstallReport = {
    status: steps.some((step) => step.outcome === "failed") ? "failed" : "completed",
    mode,
    updatedAt: new Date().toISOString(),
    steps,
  };
  return writeFileAtomicViaRename(reportPath, `${JSON.stringify(report, null, 2)}\n`).then(() => reportPath);
};

const executeUninstall = async (options: UninstallOptions, mode: UninstallMode): Promise<UninstallResult> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const remove = options.remove ?? defaultRemove;
  const teardownRuntimeService = options.teardownRuntimeService ?? defaultTeardownRuntimeService;
  const steps = buildUninstallPlan(options, mode);
  const executed: UninstallPlanStep[] = [];

  for (const step of steps) {
    if (!step.destructive || step.status !== "owned") {
      executed.push({ ...step, outcome: outcomeForSkippedStep(step) });
      continue;
    }
    try {
      if (step.id === "runtime-service" && options.userDataRoot !== undefined) {
        await teardownRuntimeService(options.userDataRoot);
      }
      await remove(step.target);
      executed.push({ ...step, outcome: "completed" });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      executed.push({ ...step, outcome: "failed", error });
    }
  }

  const failed = executed.some((step) => step.outcome === "failed");
  // Skip the report when the data root was purged: writing it would recreate the just-removed root.
  const reportPath =
    failed && existsSync(userDataRoot) ? await writeUninstallReport(userDataRoot, mode, executed) : undefined;
  return {
    dryRun: false,
    refused: false,
    mode,
    failed,
    ...(reportPath === undefined ? {} : { reportPath }),
    steps: executed,
  };
};

export const uninstall = (options: UninstallOptions = {}): Effect.Effect<UninstallResult> =>
  Effect.promise(async () => {
    const dryRun = options.dryRun === true;
    const yes = options.yes === true;
    const requestedMode: UninstallMode | undefined =
      options.purge === true ? "purge" : options.keepData === true ? "keep-data" : undefined;
    const mode = requestedMode ?? "keep-data";
    if (!dryRun && yes) return executeUninstall(options, mode);
    return {
      dryRun,
      refused: !dryRun && !yes,
      mode,
      failed: false,
      steps: buildUninstallPlan(options, mode),
    };
  });

const uninstallStepTone = (step: UninstallPlanStep): SummaryTone => {
  if (step.outcome === "failed") return "error";
  if (step.outcome === "completed") return "ok";
  if (step.status === "skipped") return "skipped";
  if (step.status === "manual" || step.status === "user-owned") return "warn";
  return "warn";
};

const uninstallSubtitle = (result: UninstallResult): string => {
  if (result.refused) return `refused · ${result.mode}`;
  if (result.dryRun) return `dry-run · ${result.mode}`;
  if (result.failed) return `incomplete · ${result.mode}`;
  return `complete · ${result.mode}`;
};

const uninstallNextSteps = (result: UninstallResult): ReadonlyArray<string> => {
  if (result.refused) return ["Rerun `lando uninstall --yes` after reviewing this plan."];
  if (result.dryRun) return ["No changes were made."];
  if (result.failed)
    return [
      `Partial failure report: ${result.reportPath ?? "unavailable"}. Rerun the same uninstall command after remediation.`,
    ];
  return ["Removed allowed Lando-owned uninstall targets."];
};

export const buildUninstallSummary = (result: UninstallResult): SummaryDocument => ({
  title: "UNINSTALL PLAN",
  tone: result.refused || result.failed ? "error" : result.dryRun ? "warn" : "ok",
  subtitle: uninstallSubtitle(result),
  sections: [
    {
      title: "targets",
      rows: result.steps.map((step) => {
        const outcome = step.outcome === undefined ? "" : ` [${step.outcome}]`;
        const detail = step.error === undefined ? step.detail : `${step.detail} Error: ${step.error}.`;
        return {
          label: step.label,
          tone: uninstallStepTone(step),
          value: `${statusLabel(step.status)}${outcome}`,
          detail,
          fields: [{ label: "target", value: step.target }],
        };
      }),
    },
  ],
  nextSteps: [...uninstallNextSteps(result)],
  footer: `${result.steps.length} targets · mode ${result.mode}`,
});

export const formatUninstallResult = (result: UninstallResult): string => {
  const heading = result.refused
    ? "uninstall refused: destructive execution requires --yes\nuninstall plan"
    : result.dryRun
      ? `uninstall plan (dry-run)\nmode: ${result.mode}`
      : result.failed
        ? `uninstall incomplete\nmode: ${result.mode}`
        : `uninstall complete\nmode: ${result.mode}`;
  const lines = result.steps.map((step) => {
    const action = step.destructive ? "destructive" : "non-destructive";
    const outcome = step.outcome === undefined ? "" : ` [${step.outcome}]`;
    const error = step.error === undefined ? "" : ` Error: ${step.error}.`;
    return `- ${step.label}: ${statusLabel(step.status)}${outcome} (${action}) — ${step.target}. ${step.detail}${error}`;
  });
  const trailer = result.refused
    ? ["Rerun `lando uninstall --yes` after reviewing this plan."]
    : result.dryRun
      ? ["No changes were made."]
      : result.failed
        ? [
            `Partial failure report: ${result.reportPath ?? "unavailable"}. Rerun the same uninstall command after remediation.`,
          ]
        : ["removed allowed Lando-owned uninstall targets."];
  return [heading, ...lines, ...trailer].join("\n");
};

export const renderUninstallResult = (
  result: UninstallResult,
  ctx?: RenderContext,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): string => {
  if (result.refused || result.failed) setExitCode(1);
  return ctx?.mode === "lando" && ctx.isTTY === true
    ? formatSummary(buildUninstallSummary(result), { columns: ctx.columns })
    : formatUninstallResult(result);
};
