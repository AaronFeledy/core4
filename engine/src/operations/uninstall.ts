import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, DateTime, Effect, Option, Result, Schema } from "effect";

import { causeMessage } from "@lando/sdk/errors";
import {
  type HostUninstallOutcomeStatus,
  type HostUninstallStepStatus,
  UninstallPlanStep as UninstallPlanStepSchema,
  UninstallStepResult,
} from "@lando/sdk/schema";
import { PrivilegeService } from "@lando/sdk/services";

import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { resolveUserCacheRoot } from "../cache/paths";
import { resolveUserDataRoot } from "../config/roots";
import { inspectOwnedExecutable } from "../install/owned-executable";
import { decodeInstallRecord } from "../install/record";
import {
  HostMaintenanceRegistry,
  type HostMaintenanceRegistryShape,
  teardownHostMaintainers,
} from "../runtime/host-maintenance";
import {
  type ManagedProviderMachineClassification,
  classifyManagedProviderMachine,
  teardownManagedProviderMachine,
} from "../runtime/managed-provider-machine";
import { cleanupAgentRelayState } from "../subsystems/ssh-agent/cleanup.ts";
import { TerminableAgentRelayWorkerRecord } from "../subsystems/ssh-agent/worker-protocol.ts";
import {
  type ContributionBinding,
  type ElevateCapability,
  UninstallContributionConflictError,
  conflictResultStep,
  contributionBlocksUserDataRoot,
  executeHostUninstallContribution,
  planHostUninstallContributions,
} from "./uninstall-contributions";
import { defaultRemoveRuntimeDir, defaultTerminateRuntimeBinProcesses } from "./uninstall-runtime-dir";
import {
  UninstallRuntimeDirError,
  formatUninstallRuntimeDirStepError,
  leftoverUninstallRuntimeDirError,
} from "./uninstall-runtime-error";
import { inspectShellenvBlocks } from "./uninstall-shell-entries";

export {
  chmodTreeUserWritable,
  defaultRemoveRuntimeDir,
  defaultTerminateRuntimeBinProcesses,
  managedPodmanUnshareRmInvocation,
  type RemoveRuntimeDirDeps,
} from "./uninstall-runtime-dir";
export {
  UNINSTALL_RUNTIME_DIR_LEFTOVER_MESSAGE,
  UninstallRuntimeDirError,
  formatUninstallRuntimeDirStepError,
  leftoverUninstallRuntimeDirError,
  preferLeftoverRuntimePath,
  uninstallRuntimeDirRemediation,
} from "./uninstall-runtime-error";
export { contributedStepId } from "./uninstall-contributions";

// allow: SIZE_OK — this behavior-preserving extraction keeps one uninstall operation on one engine seam.

export type UninstallStepStatus = typeof HostUninstallStepStatus.Type;
export type UninstallStepOutcome = typeof HostUninstallOutcomeStatus.Type;
export type UninstallMode = "keep-data" | "purge";

export type UninstallPlanStep = typeof UninstallPlanStepSchema.Type;

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
  /** Test override; production uses PrivilegeService.elevate when present. */
  readonly elevate?: (
    command: ReadonlyArray<string>,
  ) => Promise<{ readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }>;
  readonly readText?: (path: string) => string;
  readonly writeText?: (path: string, content: string) => Promise<void> | void;
  readonly terminateRuntimeBinProcesses?: (runtimeDir: string) => Promise<void>;
}

export const UninstallResultSchema = Schema.Struct({
  dryRun: Schema.Boolean,
  refused: Schema.Boolean,
  mode: Schema.Literals(["keep-data", "purge"]),
  failed: Schema.Boolean,
  reportPath: Schema.optionalKey(Schema.String),
  steps: Schema.Array(Schema.Union([UninstallPlanStepSchema, UninstallStepResult])),
});
export type UninstallResult = typeof UninstallResultSchema.Type;

export interface UninstallReport {
  readonly status: "completed" | "failed";
  readonly mode: UninstallMode;
  readonly updatedAt: string;
  readonly steps: ReadonlyArray<UninstallStepResult>;
}

const pathStatus = (path: string, exists: (path: string) => boolean): UninstallStepStatus =>
  exists(path) ? "owned" : "skipped";

const installedBinaryStep = (recordFile: string, destination?: string): UninstallPlanStep => {
  const ownership = inspectOwnedExecutable({
    recordFile,
    platform: normalizeHostPlatform(),
    ...(destination === undefined ? {} : { destination }),
  });
  const base = { id: "installed-binary", label: "installed binary", destructive: true };
  if (Result.isSuccess(ownership))
    return {
      ...base,
      target: ownership.success.path,
      status: "owned",
      detail: `The install record ${recordFile} proves ownership of this Lando 4 executable.`,
    };
  const error = ownership.failure;
  const target = error.destination ?? recordFile;
  const detail = `${error.reason}: ${error.message} ${error.remediation}`;
  switch (error.reason) {
    case "no-record":
      return {
        ...base,
        target,
        status: "skipped",
        detail: `${detail} No executable is owned without ${recordFile}.`,
      };
    case "record-invalid":
    case "record-unreadable":
      return { ...base, target, status: "manual", detail: `${detail} The install record must be repaired.` };
    case "destination-unreadable":
      if (error.destination !== undefined) {
        try {
          lstatSync(error.destination);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
            return {
              ...base,
              target,
              status: "skipped",
              detail: `The recorded executable ${target} is already absent.`,
            };
        }
      }
      return { ...base, target, status: "user-owned", detail };
    case "foreign-basename":
    case "path-mismatch":
    case "not-regular-file":
    case "digest-mismatch":
    case "size-mismatch":
      return { ...base, target, status: "user-owned", detail };
    default: {
      const exhaustive: never = error.reason;
      return exhaustive;
    }
  }
};

const uninstallShellProfiles = (options: UninstallOptions): ReadonlyArray<string> => {
  const recordFile = makeLandoPaths({
    userDataRoot: options.userDataRoot ?? resolveUserDataRoot(),
  }).installRecordFile;
  const text = tryReadText(recordFile, defaultReadText);
  const record =
    text === undefined ? undefined : Effect.runSync(Effect.result(decodeInstallRecord(text, recordFile)));
  return [
    ...new Set([
      ...(normalizeHostPlatform() === "win32" && options.shellProfilePath === undefined
        ? []
        : [options.shellProfilePath ?? defaultPosixShellProfilePath()]),
      ...(record !== undefined && Result.isSuccess(record)
        ? record.success.data.shellProfiles.map((profile) => profile.path)
        : []),
    ]),
  ];
};

const keepDataProtectedStepIds = new Set([
  "managed-provider-machines",
  "podman-network-definitions",
  "runtime-service",
  "managed-provider-runtime",
  "mutagen-binary",
  "mutagen-agents",
  "host-proxy-sessions",
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

// Lockstep with core/src/cli/commands/shellenv.ts: same delimiters, and the same
// LANDO_SHELL_PROFILE override setup uses when writing the block.
// Engine must not import @lando/core.
export const LANDO_SHELLENV_BEGIN = "# >>> LANDO4 shellenv >>>";
export const LANDO_SHELLENV_END = "# <<< LANDO4 shellenv <<<";

export const defaultPosixShellProfilePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.LANDO_SHELL_PROFILE;
  if (override !== undefined && override !== "") return override;
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

const defaultTeardownHostProxySessions = async (
  userDataRoot: string,
  privateFileAccess?: PrivateFileAccess,
): Promise<void> => {
  if (privateFileAccess === undefined) {
    throw new TypeError("Private file access is required to tear down host-proxy sessions.");
  }
  const { terminateOwnedHostProxyWorkersInRoot } = await import("../subsystems/host-proxy/worker");
  await Effect.runPromise(terminateOwnedHostProxyWorkersInRoot(userDataRoot, { privateFileAccess }));
  const paths = makeLandoPaths({ userDataRoot });
  if (!existsSync(paths.hostProxyRunRoot)) return;
  for (const entry of readdirSync(paths.hostProxyRunRoot, { withFileTypes: true })) {
    const kind = entry.name.endsWith("-ssh-agent")
      ? "ssh"
      : entry.name.endsWith("-gpg-agent")
        ? "gpg"
        : undefined;
    if (!entry.isDirectory() || kind === undefined) continue;
    const directory = join(paths.hostProxyRunRoot, entry.name);
    const text = tryReadText(join(directory, "worker.json"), defaultReadText);
    if (text === undefined) continue;
    const record = Schema.decodeUnknownOption(Schema.fromJsonString(TerminableAgentRelayWorkerRecord))(text);
    if (Option.isNone(record) || record.value.kind !== kind) continue;
    const app = { id: record.value.appId, root: record.value.appRoot };
    if (paths.agentRelayRunDir(kind, app.id, app.root) !== directory) continue;
    await Effect.runPromise(
      cleanupAgentRelayState(app, { userDataRoot }, kind).pipe(
        Effect.provideService(PrivateFileAccessService, privateFileAccess),
      ),
    );
  }
};

const defaultTeardownRuntimeService = (
  registry: Option.Option<HostMaintenanceRegistryShape>,
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
  ownership: { readonly mode: UninstallMode | undefined; readonly userDataRoot: string },
): UninstallPlanStep => {
  const base = {
    id: "shell-entries",
    label: "shell entries",
    target: profilePath,
    destructive: false,
  };
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
      status: "manual",
      detail: "Could not read the POSIX shell profile; not rewriting it.",
    };
  }
  const blocks = inspectShellenvBlocks(content, ownership.userDataRoot);
  if (!blocks.found) {
    return {
      ...base,
      status: "skipped",
      detail: "No delimited Lando shellenv block is present in the POSIX shell profile.",
    };
  }
  if (ownership.mode !== "purge") {
    return {
      ...base,
      status: "manual",
      detail: "Strip the delimited Lando shellenv block from the POSIX shell profile.",
    };
  }
  return {
    ...base,
    status: blocks.manual ? "manual" : blocks.stripped ? "owned" : "user-owned",
    detail: [
      ...(blocks.stripped
        ? ["Strip this install's delimited Lando shellenv blocks from the POSIX shell profile."]
        : []),
      ...blocks.foreignRoots.map((root) => `Leave the shellenv block for data root ${root} in place.`),
      ...(blocks.manual
        ? [
            "A shellenv block has a missing or unparseable data root; remove it by hand if it belongs to this install.",
          ]
        : []),
    ].join(" "),
  };
};

const skippedStepResult = (step: UninstallPlanStep): UninstallStepResult => {
  switch (step.status) {
    case "manual":
    case "user-owned":
      return { ...step, outcome: "manual" };
    case "owned":
    case "skipped":
      return { ...step, outcome: "skipped" };
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
};

const stepWithMode = (step: UninstallPlanStep, mode: UninstallMode): UninstallPlanStep => {
  if (mode === "keep-data" && keepDataProtectedStepIds.has(step.id)) {
    return {
      ...step,
      status: "skipped",
      detail:
        step.id === "running-apps"
          ? "Preserved by --keep-data; rerun with --purge to check for running apps."
          : step.id === "managed-provider-machines"
            ? "Preserved by --keep-data because the managed machine contains app volumes; --purge removes it."
            : step.id === "podman-network-definitions"
              ? "Preserved by --keep-data along with the managed machine; review after --purge."
              : step.id === "managed-provider-runtime"
                ? "Preserved by --keep-data to retain machine ownership state and the runtime bundle."
                : step.id === "mutagen-binary" || step.id === "mutagen-agents"
                  ? "Preserved by --keep-data so accelerated file-sync sessions can reconnect."
                  : step.id === "runtime-service" || step.id === "host-proxy-sessions"
                    ? "Preserved by --keep-data so running Lando apps retain runtime connectivity."
                    : "Preserved by --keep-data; rerun with --purge to remove this state.",
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
    const error = causeMessage(cause);
    return {
      ...base,
      target: "Lando apps",
      status: "user-owned" as const,
      detail: `Cannot verify whether Lando apps are running; discovery failed: ${error}. Uninstall cannot proceed safely.`,
    };
  }
};

interface UninstallPlanBuild {
  readonly steps: ReadonlyArray<UninstallPlanStep>;
  readonly contributionBindings: ReadonlyMap<string, ContributionBinding>;
}

export const buildUninstallPlan = async (
  options: UninstallOptions = {},
  mode?: UninstallMode,
  platform: ReturnType<typeof normalizeHostPlatform> = normalizeHostPlatform(),
  hostMaintenanceRegistry: Option.Option<HostMaintenanceRegistryShape> = Option.none(),
): Promise<ReadonlyArray<UninstallPlanStep>> => {
  const built = await buildUninstallPlanWithContributions(options, mode, platform, hostMaintenanceRegistry);
  return built.steps;
};

const buildUninstallPlanWithContributions = async (
  options: UninstallOptions = {},
  mode?: UninstallMode,
  platform: ReturnType<typeof normalizeHostPlatform> = normalizeHostPlatform(),
  hostMaintenanceRegistry: Option.Option<HostMaintenanceRegistryShape> = Option.none(),
): Promise<UninstallPlanBuild> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
  const userConfRoot = options.userConfRoot ?? makeLandoPaths({ userDataRoot }).roots.userConfRoot;
  const exists = options.exists ?? existsSync;
  const machineClassification =
    options.readManagedProviderMachine?.(userDataRoot) ??
    classifyManagedProviderMachine(userDataRoot, undefined, platform);
  const paths = makeLandoPaths({ userDataRoot });
  const binaryStep = installedBinaryStep(paths.installRecordFile);
  const runtimeDir = paths.runtimeDir;
  const managedProviderRuntime = join(userDataRoot, "providers", "provider-lando");
  const hostProxySessions = paths.hostProxyRunRoot;
  const readText = options.readText ?? defaultReadText;
  const cgroupsDelegatePath = options.cgroupsDelegatePath ?? DEFAULT_CGROUPS_DELEGATE_PATH;
  const shellSteps = uninstallShellProfiles(options).map((path) =>
    shellEntriesStep(path, exists, readText, { mode, userDataRoot }),
  );
  const shellStep: UninstallPlanStep = {
    id: "shell-entries",
    label: "shell entries",
    destructive: false,
    target: shellSteps.map((step) => step.target).join(", "),
    status: shellSteps.some((step) => step.status === "manual")
      ? "manual"
      : shellSteps.some((step) => step.status === "owned")
        ? "owned"
        : shellSteps.some((step) => step.status === "user-owned")
          ? "user-owned"
          : "skipped",
    detail: shellSteps.map((step) => step.detail).join(" "),
  };
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

  const steps: UninstallPlanStep[] = [
    runningAppsStep,
    managedProviderMachineStep(machineClassification),
    ...(platform === "win32" && machineClassification.ownership !== "absent"
      ? [
          {
            id: "podman-network-definitions",
            label: "Windows Podman network definitions",
            target: "Windows Podman network config",
            destructive: false,
            status: "manual" as const,
            detail:
              "Podman stores network definitions outside its WSL machine. Unlabeled definitions can survive VM removal; review residual Lando networks manually and leave entries with uncertain ownership in place.",
          },
        ]
      : []),
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
    binaryStep,
    ...(platform === "linux" || platform === "wsl"
      ? [cgroupsDelegateStep(cgroupsDelegatePath, exists, readText)]
      : []),
    platform === "win32"
      ? {
          ...shellStep,
          target: "PowerShell profiles",
          status: "manual",
          detail:
            "Windows setup does not edit PowerShell profiles. Review any Lando shellenv lines you added manually.",
        }
      : shellStep,
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
    {
      id: "install-record",
      label: "install record",
      target: paths.installRecordFile,
      destructive: true,
      status: Result.match(
        inspectOwnedExecutable({ recordFile: paths.installRecordFile, platform: paths.platform }),
        {
          onFailure: (error) => (error.reason === "no-record" ? ("skipped" as const) : ("owned" as const)),
          onSuccess: () => "owned" as const,
        },
      ),
      detail:
        "Remove the install record last, only after executable and shell cleanup completed or were skipped.",
    },
  ];

  const contributionPlan = await Effect.runPromise(
    Effect.result(
      planHostUninstallContributions(Option.getOrUndefined(hostMaintenanceRegistry), {
        platform,
        userDataRoot,
        ...(mode === undefined ? {} : { mode }),
      }),
    ),
  );
  if (Result.isFailure(contributionPlan)) {
    throw contributionPlan.failure;
  }
  const { steps: contributedSteps, bindings } = contributionPlan.success;

  const globalStateIndex = steps.findIndex((step) => step.id === "global-app-state");
  const insertAt = globalStateIndex === -1 ? steps.length : globalStateIndex;
  const merged = [...steps.slice(0, insertAt), ...contributedSteps, ...steps.slice(insertAt)];
  const withMode = mode === undefined ? merged : merged.map((step) => stepWithMode(step, mode));
  return { steps: withMode, contributionBindings: bindings };
};

const writeUninstallReport = async (
  reportPath: string,
  mode: UninstallMode,
  steps: ReadonlyArray<UninstallStepResult>,
): Promise<string> => {
  const report: UninstallReport = {
    status: steps.some((step) => step.outcome === "failed") ? "failed" : "completed",
    mode,
    updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    steps,
  };
  await writeFileAtomicViaRename(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
};

// Setup writes these into bin without an install record. They are Lando's own
// tools, so a purge with no record may still remove the data root. Any other
// name (a foreign `lando`, a backup, a user file) keeps the root.
const MANAGED_BIN_ENTRY_NAMES = new Set([
  "mutagen",
  "mutagen.exe",
  "mutagen-agents",
  "mkcert",
  "mkcert.exe",
  "mkcert.sha256",
  ".mkcert.version",
]);

const binDirHoldsPreservedEntry = (binDir: string): boolean => {
  let names: string[];
  try {
    names = readdirSync(binDir);
  } catch {
    return false;
  }
  return names.some((name) => !MANAGED_BIN_ENTRY_NAMES.has(name));
};

const executeUninstall = async (
  options: UninstallOptions,
  mode: UninstallMode,
  hostMaintenanceRegistry: Option.Option<HostMaintenanceRegistryShape>,
  elevateEffect?: ElevateCapability,
): Promise<UninstallResult> => {
  const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
  const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
  const platform = normalizeHostPlatform();
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

  let planBuild: UninstallPlanBuild;
  try {
    planBuild = await buildUninstallPlanWithContributions(options, mode, platform, hostMaintenanceRegistry);
  } catch (cause) {
    if (cause instanceof UninstallContributionConflictError) {
      const step = conflictResultStep(cause);
      const executed = [step];
      const reportTarget = existsSync(userDataRoot)
        ? uninstallReportPath(userDataRoot)
        : await fallbackUninstallReportPath(options.reportFallbackDir);
      let reportPath: string | undefined;
      try {
        reportPath = await writeUninstallReport(reportTarget, mode, executed);
      } catch {
        reportPath = undefined;
      }
      return {
        dryRun: false,
        refused: false,
        mode,
        failed: true,
        ...(reportPath === undefined ? {} : { reportPath }),
        steps: executed,
      };
    }
    throw cause;
  }

  const { steps, contributionBindings } = planBuild;
  const shellProfiles = uninstallShellProfiles(options);
  const recordFile = makeLandoPaths({ userDataRoot }).installRecordFile;
  const executed: UninstallStepResult[] = [];
  let blockUserDataRoot = false;

  for (const step of steps) {
    const contribution = contributionBindings.get(step.id);
    if (contribution !== undefined) {
      // Contributed steps never fall through to generic remove(step.target), and
      // only owned ones reach the maintainer's execute.
      if (step.status !== "owned") {
        executed.push(skippedStepResult(step));
        continue;
      }
      try {
        const result = await Effect.runPromise(
          executeHostUninstallContribution(contribution, {
            platform,
            userDataRoot,
            ...(elevateEffect === undefined ? {} : { elevate: elevateEffect }),
          }),
        );
        if (contributionBlocksUserDataRoot(step.status, result.outcome)) {
          blockUserDataRoot = true;
        }
        executed.push({
          ...step,
          ...result,
          detail: result.detail ?? step.detail,
        });
      } catch (cause) {
        blockUserDataRoot = true;
        executed.push({ ...step, outcome: "failed", error: causeMessage(cause) });
      }
      continue;
    }
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
        executed.push(skippedStepResult(step));
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
        const error = causeMessage(cause);
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
        const error = causeMessage(cause);
        executed.push({ ...step, outcome: "failed", error });
      }
      continue;
    }
    if (step.id === "shell-entries") {
      // keep-data leaves every block. Purge still strips readable profiles when
      // one sibling is unreadable; that sibling stays manual and holds the record.
      if (step.status !== "owned" && !(mode === "purge" && step.status === "manual")) {
        executed.push(skippedStepResult(step));
        continue;
      }
      try {
        let unresolved = false;
        for (const profile of shellProfiles) {
          if (!exists(profile)) continue;
          const content = tryReadText(profile, readText);
          if (content === undefined) {
            unresolved = true;
            continue;
          }
          const { content: rewritten, stripped, manual } = inspectShellenvBlocks(content, userDataRoot);
          unresolved ||= manual;
          if (stripped) await writeText(profile, rewritten);
        }
        executed.push(unresolved ? { ...step, outcome: "manual" } : { ...step, outcome: "completed" });
      } catch (cause) {
        const error = causeMessage(cause);
        executed.push({ ...step, outcome: "failed", error });
      }
      continue;
    }
    if (!step.destructive || step.status !== "owned") {
      executed.push(skippedStepResult(step));
      continue;
    }
    try {
      if (step.id === "installed-binary") {
        const current = installedBinaryStep(recordFile, step.target);
        if (current.status !== "owned") {
          executed.push(
            current.status === "skipped"
              ? { ...step, outcome: "skipped", detail: current.detail }
              : { ...step, outcome: "manual", detail: current.detail },
          );
          continue;
        }
      }
      if (
        step.id === "install-record" &&
        !["installed-binary", "shell-entries"].every((id) =>
          executed.some((entry) => {
            if (entry.id !== id) return false;
            if (entry.outcome === "completed" || entry.outcome === "skipped") return true;
            // keep-data deliberately leaves the shellenv block. That is resolved
            // cleanup, not a reason to keep a record pointing at a deleted binary.
            return mode === "keep-data" && id === "shell-entries" && entry.outcome === "manual";
          }),
        )
      ) {
        executed.push({
          ...step,
          outcome: "manual",
          detail: "Preserve the install record until executable and shell cleanup is resolved.",
        });
        continue;
      }
      if (step.id === "user-data-root" && blockUserDataRoot) {
        // Owned contribution failure or ownership loss keeps the data root so the
        // uninstall report and residual evidence remain for resume. outcome failed
        // so the overall result writes a report and failed is true.
        executed.push({
          ...step,
          outcome: "failed",
          detail:
            "Preserve the data root because a host-maintainer contribution failed or lost ownership; inspect the uninstall report and rerun after fixing the failure.",
          error:
            "Host-maintainer contribution did not complete; data root preserved for inspection and resume.",
        });
        continue;
      }
      if (
        step.id === "user-data-root" &&
        (existsSync(recordFile) || binDirHoldsPreservedEntry(makeLandoPaths({ userDataRoot }).binDir))
      ) {
        // Defer while the record is still present, or while bin holds a file this
        // uninstall did not install. Managed setup tools do not count: with no
        // record there is nothing later to retire, so purge removes the root now.
        executed.push({
          ...step,
          outcome: "manual",
          detail: existsSync(recordFile)
            ? "Preserve the data root until the install record is removed."
            : "Preserve the data root because its bin directory holds a file Lando did not install.",
        });
        continue;
      }
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
          throw leftoverUninstallRuntimeDirError(step.target, exists);
        }
      } else {
        await remove(step.target);
      }

      if (step.id === "install-record" && mode === "purge") {
        const binaryResolved = executed.some(
          (entry) =>
            entry.id === "installed-binary" && (entry.outcome === "completed" || entry.outcome === "skipped"),
        );
        // Never remove the data root after install-record when a contribution blocked
        // it: that path previously bypassed the earlier user-data-root guard and
        // destroyed residual evidence (report target, markers) needed for resume.
        if (binaryResolved && !blockUserDataRoot) {
          await remove(userDataRoot);
          const deferred = executed.findIndex((entry) => entry.id === "user-data-root");
          const deferredStep = steps.find((entry) => entry.id === "user-data-root");
          if (executed[deferred]?.outcome === "manual" && deferredStep?.status === "owned") {
            executed[deferred] = {
              ...deferredStep,
              outcome: "completed",
              detail: "Removed the data root after the install record.",
            };
          }
        }
      }

      executed.push({ ...step, outcome: "completed" });
    } catch (cause) {
      const error =
        cause instanceof UninstallRuntimeDirError
          ? formatUninstallRuntimeDirStepError(cause)
          : cause instanceof Error
            ? cause.message
            : String(cause);
      executed.push({ ...step, outcome: "failed", error });
      if (step.id === "managed-provider-machines" || step.id === "runtime-service") break;
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

const toElevateCapability = (
  options: UninstallOptions,
  privilege: Option.Option<Context.Service.Shape<typeof PrivilegeService>>,
): ElevateCapability | undefined => {
  if (options.elevate !== undefined) {
    const elevate = options.elevate;
    return (command) =>
      Effect.tryPromise({
        try: async () => {
          const result = await elevate(command);
          return {
            exitCode: result.exitCode,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          };
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: causeMessage(cause),
          }),
        ),
      );
  }
  if (Option.isSome(privilege)) return privilege.value.elevate;
  return undefined;
};

export const uninstall = Effect.fn("AppOperation.uninstall")(function* (
  options: UninstallOptions = {},
): Effect.fn.Return<UninstallResult, never, PrivateFileAccessService> {
  const hostMaintenanceRegistry = yield* Effect.serviceOption(HostMaintenanceRegistry);
  const privilege = yield* Effect.serviceOption(PrivilegeService);
  const privateFileAccess = yield* PrivateFileAccessService;
  const elevateEffect = toElevateCapability(options, privilege);
  const elevate =
    options.elevate ??
    (elevateEffect === undefined
      ? undefined
      : (command: ReadonlyArray<string>) => Effect.runPromise(elevateEffect(command)));
  const teardownHostProxySessions =
    options.teardownHostProxySessions ??
    ((userDataRoot: string) => defaultTeardownHostProxySessions(userDataRoot, privateFileAccess));
  const resolvedOptions = {
    ...options,
    ...(elevate === undefined ? {} : { elevate }),
    teardownHostProxySessions,
  };
  const dryRun = options.dryRun === true;
  const yes = options.yes === true;
  const requestedMode: UninstallMode | undefined =
    options.purge === true ? "purge" : options.keepData === true ? "keep-data" : undefined;
  const mode = requestedMode ?? "keep-data";
  if (!dryRun && yes)
    return yield* Effect.promise(() =>
      executeUninstall(resolvedOptions, mode, hostMaintenanceRegistry, elevateEffect),
    );

  try {
    const steps = yield* Effect.promise(() =>
      buildUninstallPlan(options, mode, normalizeHostPlatform(), hostMaintenanceRegistry),
    );
    return {
      dryRun,
      refused: !dryRun && !yes,
      mode,
      failed: false,
      steps,
    };
  } catch (cause) {
    if (cause instanceof UninstallContributionConflictError) {
      return {
        dryRun,
        refused: false,
        mode,
        failed: true,
        steps: [conflictResultStep(cause)],
      };
    }
    throw cause;
  }
});
