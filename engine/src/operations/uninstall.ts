import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type Context, Effect, Option, Schema } from "effect";

import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { resolveUserCacheRoot } from "../cache/paths";
import { resolveUserDataRoot } from "../config/roots";
import { HostMaintenanceRegistry, teardownHostMaintainers } from "../runtime/host-maintenance";
import {
  type ManagedProviderMachineClassification,
  classifyManagedProviderMachine,
  teardownManagedProviderMachine,
} from "../runtime/managed-provider-machine";
import { defaultRemoveRuntimeDir, defaultTerminateRuntimeBinProcesses } from "./uninstall-runtime-dir";

export {
  chmodTreeUserWritable,
  defaultRemoveRuntimeDir,
  defaultTerminateRuntimeBinProcesses,
  managedPodmanUnshareRmInvocation,
} from "./uninstall-runtime-dir";

// allow: SIZE_OK — this behavior-preserving extraction keeps one uninstall operation on one engine seam.

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

export const UninstallPlanStepSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  destructive: Schema.Boolean,
  status: Schema.Literal("owned", "user-owned", "skipped", "manual"),
  detail: Schema.String,
  outcome: Schema.optional(Schema.Literal("completed", "failed", "manual", "skipped")),
  error: Schema.optional(Schema.String),
});

export interface DiscoveredApp {
  readonly appId: string;
  readonly appName: string;
  readonly providerId: string;
  readonly appRoot: string;
  readonly services: ReadonlyArray<string>;
}

export interface UninstallOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly keepData?: boolean;
  readonly purge?: boolean;
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
  readonly userConfRoot?: string;
  readonly execPath?: string;
  readonly exists?: (path: string) => boolean;
  readonly remove?: (path: string) => Promise<void>;
  readonly teardownRuntimeService?: (
    userDataRoot: string,
  ) => Promise<{ readonly terminated: boolean; readonly pid?: number }>;
  readonly readManagedProviderMachine?: (userDataRoot: string) => ManagedProviderMachineClassification;
  readonly teardownProviderMachines?: (
    userDataRoot: string,
  ) => Promise<{ readonly removed: boolean; readonly name?: string }>;
  readonly teardownHostProxySessions?: (userDataRoot: string) => Promise<void>;
  readonly listDiscoveredApps?: (
    userDataRoot: string,
    userCacheRoot: string,
  ) => Promise<ReadonlyArray<DiscoveredApp>>;
  readonly cleanupDiscoveredApps?: (apps: ReadonlyArray<DiscoveredApp>) => Promise<void>;
  readonly reportFallbackDir?: string;
  readonly cgroupsDelegatePath?: string;
  readonly shellProfilePath?: string;
  readonly readText?: (path: string) => string;
  readonly writeText?: (path: string, content: string) => Promise<void> | void;
  readonly terminateRuntimeBinProcesses?: (runtimeDir: string) => Promise<void>;
}

export interface UninstallResult {
  readonly dryRun: boolean;
  readonly refused: boolean;
  readonly mode: UninstallMode;
  readonly failed: boolean;
  readonly reportPath?: string;
  readonly steps: ReadonlyArray<UninstallPlanStep>;
}

export const UninstallResultSchema = Schema.Struct({
  dryRun: Schema.Boolean,
  refused: Schema.Boolean,
  mode: Schema.Literal("keep-data", "purge"),
  failed: Schema.Boolean,
  reportPath: Schema.optional(Schema.String),
  steps: Schema.Array(UninstallPlanStepSchema),
});

export interface UninstallReport {
  readonly status: "completed" | "failed";
  readonly mode: UninstallMode;
  readonly updatedAt: string;
  readonly steps: ReadonlyArray<UninstallPlanStep>;
}

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

const keepDataProtectedStepIds = new Set([
  "global-app-state",
  "caches",
  "user-data-root",
  "user-cache-root",
  "running-apps",
  "user-conf-root",
]);

const uninstallReportPath = (userDataRoot: string): string => join(userDataRoot, "uninstall", "report.json");

const fallbackUninstallReportPath = async (reportFallbackDir?: string): Promise<string> => {
  const fallbackDir = reportFallbackDir ?? (await mkdtemp(join(tmpdir(), "lando-uninstall-")));
  return join(fallbackDir, "lando-uninstall-report.json");
};

const defaultRemove = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

const defaultReadText = (path: string): string => readFileSync(path, "utf8");

const defaultWriteText = (path: string, content: string): void => {
  writeFileSync(path, content, "utf8");
};

// Lockstep with plugins/provider-lando/src/prerequisite-provision.ts DELEGATE_CONF_CONTENT.
// Engine must not import @lando/provider-lando.
export const CGROUPS_DELEGATE_CONF_CONTENT = `[Service]
Delegate=cpu cpuset io memory pids
`;

export const DEFAULT_CGROUPS_DELEGATE_PATH = "/etc/systemd/system/user@.service.d/delegate.conf";

// Setup writes this via echo, which appends an extra trailing newline.
const isLandoManagedCgroupsDelegateContent = (content: string): boolean =>
  content.trim() === CGROUPS_DELEGATE_CONF_CONTENT.trim();

// Lockstep with core/src/cli/commands/shellenv.ts landoShellenvBlock delimiters.
// Engine must not import @lando/core.
export const LANDO_SHELLENV_BEGIN = "# >>> LANDO shellenv >>>";
export const LANDO_SHELLENV_END = "# <<< LANDO shellenv <<<";

export const defaultPosixShellProfilePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const shell = env.SHELL?.split(/[\\/]/u).at(-1) ?? "";
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
};

export const stripLandoShellenvBlock = (
  content: string,
): { readonly content: string; readonly stripped: boolean } => {
  let result = content;
  let stripped = false;
  for (;;) {
    const begin = result.indexOf(LANDO_SHELLENV_BEGIN);
    if (begin === -1) break;
    const end = result.indexOf(LANDO_SHELLENV_END, begin + LANDO_SHELLENV_BEGIN.length);
    if (end === -1) break;
    let cutEnd = end + LANDO_SHELLENV_END.length;
    if (result.startsWith("\r\n", cutEnd)) cutEnd += 2;
    else if (result.startsWith("\n", cutEnd)) cutEnd += 1;
    result = `${result.slice(0, begin)}${result.slice(cutEnd)}`;
    stripped = true;
  }
  return { content: result, stripped };
};

const tryReadText = (path: string, readText: (path: string) => string): string | undefined => {
  try {
    return readText(path);
  } catch {
    return undefined;
  }
};

const defaultTeardownHostProxySessions = async (userDataRoot: string): Promise<void> => {
  const { terminateOwnedHostProxyWorkersInRoot } = await import("../subsystems/host-proxy/worker");
  await Effect.runPromise(terminateOwnedHostProxyWorkersInRoot(userDataRoot));
};

const defaultTeardownRuntimeService = (
  registry: Option.Option<Context.Tag.Service<typeof HostMaintenanceRegistry>>,
  userDataRoot: string,
): Promise<{ readonly terminated: boolean; readonly pid?: number }> => {
  const platform = normalizeHostPlatform();
  const paths = makeLandoPaths({ userDataRoot, platform });
  return Option.match(registry, {
    onNone: () => Promise.resolve({ terminated: false }),
    onSome: (service) => Effect.runPromise(teardownHostMaintainers(service, { paths, platform })),
  });
};

const managedProviderMachineStep = (
  classification: ManagedProviderMachineClassification,
): UninstallPlanStep => {
  const base = { id: "managed-provider-machines", label: "managed provider machines", destructive: true };
  const machineName = classification.name ?? "lando";
  switch (classification.ownership) {
    case "owned":
      return {
        ...base,
        target: machineName,
        status: "owned",
        detail: `Remove the Lando-created managed provider machine "${machineName}".`,
      };
    case "not-owned":
      return {
        ...base,
        target: machineName,
        status: "user-owned",
        detail: `The "${machineName}" provider machine was not created by Lando; remove it manually with \`podman machine rm ${machineName}\` if you no longer need it.`,
      };
    case "ambiguous":
      return {
        ...base,
        target: "Lando-managed provider machines",
        status: "manual",
        detail:
          "Provider machine ownership could not be determined from setup state; review and remove Lando-managed provider machines manually.",
      };
    case "absent":
      return {
        ...base,
        target: "Lando-managed provider machines",
        status: "skipped",
        detail: "No managed provider machine is recorded in setup state.",
      };
  }
};

const cgroupsDelegateStep = (
  path: string,
  exists: (path: string) => boolean,
  readText: (path: string) => string,
): UninstallPlanStep => {
  const base = {
    id: "cgroups-delegate",
    label: "cgroups delegation drop-in",
    target: path,
    destructive: true,
  };
  if (!exists(path)) {
    return {
      ...base,
      status: "skipped",
      detail: "No Lando-managed cgroups delegation drop-in is present.",
    };
  }
  const content = tryReadText(path, readText);
  if (content === undefined) {
    return {
      ...base,
      status: "user-owned",
      detail: "Could not read the cgroups delegation drop-in; not removing it.",
    };
  }
  if (isLandoManagedCgroupsDelegateContent(content)) {
    return {
      ...base,
      status: "owned",
      detail: "Remove the Lando-managed systemd user cgroup delegation drop-in.",
    };
  }
  return {
    ...base,
    status: "user-owned",
    detail: "The cgroups delegation drop-in exists but is not the Lando-managed content; leave it in place.",
  };
};

const shellEntriesStep = (
  profilePath: string,
  exists: (path: string) => boolean,
  readText: (path: string) => string,
  mode: UninstallMode | undefined,
): UninstallPlanStep => {
  const base = {
    id: "shell-entries",
    label: "shell entries",
    target: profilePath,
    destructive: false,
  };
  if (mode !== "purge") {
    return {
      ...base,
      status: "manual",
      detail: "Remove clearly delimited Lando shellenv blocks from shell profiles.",
    };
  }
  if (!exists(profilePath)) {
    return {
      ...base,
      status: "skipped",
      detail: "No POSIX shell profile with a Lando shellenv block is present.",
    };
  }
  const content = tryReadText(profilePath, readText);
  if (content === undefined) {
    return {
      ...base,
      status: "skipped",
      detail: "Could not read the POSIX shell profile; not rewriting it.",
    };
  }
  const { stripped } = stripLandoShellenvBlock(content);
  if (!stripped) {
    return {
      ...base,
      status: "skipped",
      detail: "No delimited Lando shellenv block is present in the POSIX shell profile.",
    };
  }
  return {
    ...base,
    status: "owned",
    detail: "Strip the delimited Lando shellenv block from the POSIX shell profile.",
  };
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
      detail:
        step.id === "running-apps"
          ? "Preserved by --keep-data; rerun with --purge to check for running apps."
          : "Preserved by --keep-data; rerun with --purge to remove this state.",
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

const buildRunningAppsStep = async (
  userDataRoot: string,
  userCacheRoot: string,
  listDiscoveredApps?: (userDataRoot: string, userCacheRoot: string) => Promise<ReadonlyArray<DiscoveredApp>>,
): Promise<UninstallPlanStep> => {
  const base = {
    id: "running-apps",
    label: "running Lando apps and provider resources",
    destructive: true,
  };
  if (listDiscoveredApps === undefined) {
    // Fail closed: cannot verify safety, so refuse to proceed
    return {
      ...base,
      target: "Lando apps",
      status: "user-owned" as const,
      detail:
        "Cannot verify whether Lando apps are running; discovery failed (container runtime unavailable). Uninstall cannot proceed safely.",
    };
  }
  try {
    const apps = await listDiscoveredApps(userDataRoot, userCacheRoot);
    if (apps.length === 0) {
      return {
        ...base,
        target: "Lando apps",
        status: "owned" as const,
        detail:
          "No running Lando apps found. Will clean up any leftover Lando-labeled containers and resources.",
      };
    }
    const appList = apps.map((app) => app.appId).join(", ");
    return {
      ...base,
      target: `${apps.length} app${apps.length === 1 ? "" : "s"}: ${appList}`,
      status: "owned" as const,
      detail: `Found ${apps.length} running Lando app${apps.length === 1 ? "" : "s"}. Will stop and remove ${apps.length === 1 ? "it" : "them"} along with unused Lando networks and volumes.`,
    };
  } catch (cause) {
    // Fail closed: discovery failed, cannot verify safety
    const error = cause instanceof Error ? cause.message : String(cause);
    return {
      ...base,
      target: "Lando apps",
      status: "user-owned" as const,
      detail: `Cannot verify whether Lando apps are running; discovery failed: ${error}. Uninstall cannot proceed safely.`,
    };
  }
};

export const buildUninstallPlan = async (
  options: UninstallOptions = {},
  mode?: UninstallMode,
): Promise<ReadonlyArray<UninstallPlanStep>> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
  const userConfRoot = options.userConfRoot ?? makeLandoPaths({ userDataRoot }).roots.userConfRoot;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const classifyMachine = options.readManagedProviderMachine ?? classifyManagedProviderMachine;
  const machineClassification = classifyMachine(userDataRoot);
  const paths = makeLandoPaths({ userDataRoot });
  const runtimeDir = paths.runtimeDir;
  const managedProviderRuntime = join(userDataRoot, "providers", "provider-lando");
  const hostProxySessions = paths.hostProxyRunRoot;
  const readText = options.readText ?? defaultReadText;
  const cgroupsDelegatePath = options.cgroupsDelegatePath ?? DEFAULT_CGROUPS_DELEGATE_PATH;
  const shellProfilePath = options.shellProfilePath ?? defaultPosixShellProfilePath();
  const mutagenBinary = join(paths.binDir, paths.platform === "win32" ? "mutagen.exe" : "mutagen");
  const mutagenAgents = join(paths.binDir, "mutagen-agents");
  const globalAppState = paths.globalAppRoot;

  // keep-data never touches app state, so skip container-runtime discovery
  // entirely; stepWithMode marks the step as preserved.
  const runningAppsStep = await buildRunningAppsStep(
    userDataRoot,
    userCacheRoot,
    mode === "keep-data" ? undefined : options.listDiscoveredApps,
  );

  const steps: ReadonlyArray<UninstallPlanStep> = [
    runningAppsStep,
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
    managedProviderMachineStep(machineClassification),
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
      id: "host-proxy-sessions",
      label: "host-proxy sessions",
      target: hostProxySessions,
      destructive: false,
      status: pathStatus(hostProxySessions, exists),
      detail: "Terminate owned host-proxy workers and remove only app-scoped host-proxy sockets and shims.",
    },
    {
      id: "installed-binary",
      label: "installed binary",
      target: execPath,
      destructive: true,
      status: installedBinaryStatus(execPath, userDataRoot),
      detail: "Remove automatically only when the binary lives in Lando's managed bin directory.",
    },
    cgroupsDelegateStep(cgroupsDelegatePath, exists, readText),
    shellEntriesStep(shellProfilePath, exists, readText, mode),
    {
      id: "user-conf-root",
      label: "user config root",
      target: userConfRoot,
      destructive: true,
      status: pathStatus(userConfRoot, exists),
      detail: "Remove Lando user config directory.",
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

const writeUninstallReport = async (
  reportPath: string,
  mode: UninstallMode,
  steps: ReadonlyArray<UninstallPlanStep>,
): Promise<string> => {
  const report: UninstallReport = {
    status: steps.some((step) => step.outcome === "failed") ? "failed" : "completed",
    mode,
    updatedAt: new Date().toISOString(),
    steps,
  };
  await writeFileAtomicViaRename(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
};

const executeUninstall = async (
  options: UninstallOptions,
  mode: UninstallMode,
  hostMaintenanceRegistry: Option.Option<Context.Tag.Service<typeof HostMaintenanceRegistry>>,
): Promise<UninstallResult> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
  const remove = options.remove ?? defaultRemove;
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const readText = options.readText ?? defaultReadText;
  const writeText = options.writeText ?? defaultWriteText;
  const terminateRuntimeBinProcesses =
    options.terminateRuntimeBinProcesses ?? defaultTerminateRuntimeBinProcesses;
  const teardownRuntimeService =
    options.teardownRuntimeService ??
    ((root: string) => defaultTeardownRuntimeService(hostMaintenanceRegistry, root));
  const teardownProviderMachines =
    options.teardownProviderMachines ?? ((root: string) => teardownManagedProviderMachine(root));
  const teardownHostProxySessions = options.teardownHostProxySessions ?? defaultTeardownHostProxySessions;
  const steps = await buildUninstallPlan(options, mode);
  const executed: UninstallPlanStep[] = [];

  for (const step of steps) {
    if (step.id === "running-apps") {
      // This step's target is a description, never a filesystem path; it must
      // not fall through to remove(step.target).
      if (step.status === "user-owned") {
        // Discovery failed or unavailable - fail closed
        executed.push({
          ...step,
          outcome: "failed",
          error: step.detail ?? "Cannot verify running apps; uninstall cannot proceed safely.",
        });
        // Abort immediately: do not process any remaining destructive steps
        break;
      }
      if (step.status !== "owned") {
        executed.push({ ...step, outcome: outcomeForSkippedStep(step) });
        continue;
      }
      // Discovery succeeded: re-list for a fresh snapshot, then sweep leftover
      // Lando containers, networks, and volumes even when no app is running.
      try {
        const apps =
          options.listDiscoveredApps === undefined
            ? []
            : await options.listDiscoveredApps(userDataRoot, userCacheRoot);
        if (options.cleanupDiscoveredApps !== undefined) {
          await options.cleanupDiscoveredApps(apps);
        }
        executed.push({ ...step, outcome: "completed" });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        executed.push({ ...step, outcome: "failed", error });
        // If cleanup fails, abort to prevent orphaning resources
        break;
      }
      continue;
    }
    if (step.id === "host-proxy-sessions" && step.status === "owned") {
      try {
        await teardownHostProxySessions(userDataRoot);
        executed.push({ ...step, outcome: "completed" });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        executed.push({ ...step, outcome: "failed", error });
      }
      continue;
    }
    if (step.id === "shell-entries") {
      if (step.status !== "owned") {
        executed.push({ ...step, outcome: outcomeForSkippedStep(step) });
        continue;
      }
      try {
        const content = readText(step.target);
        const { content: rewritten, stripped } = stripLandoShellenvBlock(content);
        if (stripped) await writeText(step.target, rewritten);
        executed.push({ ...step, outcome: "completed" });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        executed.push({ ...step, outcome: "failed", error });
      }
      continue;
    }
    if (!step.destructive || step.status !== "owned") {
      executed.push({ ...step, outcome: outcomeForSkippedStep(step) });
      continue;
    }
    try {
      if (step.id === "runtime-service") {
        const result = await teardownRuntimeService(userDataRoot);
        if (!result.terminated && result.pid !== undefined) {
          throw new Error("managed runtime service was not terminated");
        }
        await terminateRuntimeBinProcesses(step.target);
      }
      if (step.id === "managed-provider-machines") {
        // The target is a machine NAME, not a filesystem path: tear it down via the
        // provider-machine seam and never fall through to remove(step.target).
        await teardownProviderMachines(userDataRoot);
        executed.push({ ...step, outcome: "completed" });
        continue;
      }
      if (step.id === "runtime-service") {
        await (options.remove ?? defaultRemoveRuntimeDir)(step.target);
        // Verify removal: lingering mounts or processes can survive a
        // successful-looking rm and would leave the runtime half-removed.
        if (exists(step.target)) {
          throw new Error(
            `Failed to remove runtime directory: ${step.target} still exists after removal attempt. Lingering processes or mounts may be holding it.`,
          );
        }
      } else {
        await remove(step.target);
      }

      executed.push({ ...step, outcome: "completed" });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      executed.push({ ...step, outcome: "failed", error });
    }
  }

  const failed = executed.some((step) => step.outcome === "failed");
  // Only resolve (and possibly mkdtemp) a report location when there is actually a
  // failure report to write; a clean run must never allocate a fallback temp dir.
  // Writing the report is best-effort: if it throws (e.g. the fallback dir itself is
  // unwritable) the uninstall result still reports the real step outcomes instead of
  // rejecting the whole promise.
  let reportPath: string | undefined;
  if (failed) {
    const reportTarget = existsSync(userDataRoot)
      ? uninstallReportPath(userDataRoot)
      : await fallbackUninstallReportPath(options.reportFallbackDir);
    try {
      reportPath = await writeUninstallReport(reportTarget, mode, executed);
    } catch {
      reportPath = undefined;
    }
  }
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
  Effect.gen(function* () {
    const hostMaintenanceRegistry = yield* Effect.serviceOption(HostMaintenanceRegistry);
    const dryRun = options.dryRun === true;
    const yes = options.yes === true;
    const requestedMode: UninstallMode | undefined =
      options.purge === true ? "purge" : options.keepData === true ? "keep-data" : undefined;
    const mode = requestedMode ?? "keep-data";
    if (!dryRun && yes)
      return yield* Effect.promise(() => executeUninstall(options, mode, hostMaintenanceRegistry));
    const steps = yield* Effect.promise(() => buildUninstallPlan(options, mode));
    return {
      dryRun,
      refused: !dryRun && !yes,
      mode,
      failed: false,
      steps,
    };
  });
