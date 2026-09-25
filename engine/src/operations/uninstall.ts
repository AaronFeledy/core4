import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, Effect, Either, Option, Schema } from "effect";

import { PrivilegeService } from "@lando/sdk/services";

import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { resolveUserCacheRoot } from "../cache/paths";
import { resolveUserDataRoot } from "../config/roots";
import { inspectOwnedExecutable } from "../install/owned-executable";
import { decodeInstallRecord } from "../install/record";
import { HostMaintenanceRegistry, teardownHostMaintainers } from "../runtime/host-maintenance";
import {
  type ManagedProviderMachineClassification,
  classifyManagedProviderMachine,
  teardownManagedProviderMachine,
} from "../runtime/managed-provider-machine";
import { cleanupAgentRelayState } from "../subsystems/ssh-agent/cleanup.ts";
import { AgentRelayWorkerRecord } from "../subsystems/ssh-agent/worker-protocol.ts";
import { defaultRemoveRuntimeDir, defaultTerminateRuntimeBinProcesses } from "./uninstall-runtime-dir";
import {
  UninstallRuntimeDirError,
  formatUninstallRuntimeDirStepError,
  leftoverUninstallRuntimeDirError,
} from "./uninstall-runtime-error";
import {
  DEFAULT_SOCKET_PROXY_POLKIT_PATH,
  DEFAULT_SOCKET_PROXY_UNIT_PATHS,
  executeSocketProxyHelperStep,
  socketProxyHelperStep,
} from "./uninstall-socket-proxy";

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
  readonly socketProxyUnitPaths?: ReadonlyArray<string>;
  readonly socketProxyPolkitPath?: string;
  readonly elevate?: (
    command: ReadonlyArray<string>,
  ) => Promise<{ readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }>;
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

const installedBinaryStep = (recordFile: string, destination?: string): UninstallPlanStep => {
  const ownership = inspectOwnedExecutable({
    recordFile,
    platform: normalizeHostPlatform(),
    ...(destination === undefined ? {} : { destination }),
  });
  const base = { id: "installed-binary", label: "installed binary", destructive: true };
  if (Either.isRight(ownership))
    return {
      ...base,
      target: ownership.right.path,
      status: "owned",
      detail: `The install record ${recordFile} proves ownership of this Lando 4 executable.`,
    };
  const error = ownership.left;
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
    text === undefined ? undefined : Effect.runSync(Effect.either(decodeInstallRecord(text, recordFile)));
  return [
    ...new Set([
      ...(normalizeHostPlatform() === "win32" && options.shellProfilePath === undefined
        ? []
        : [options.shellProfilePath ?? defaultPosixShellProfilePath()]),
      ...(record !== undefined && Either.isRight(record)
        ? record.right.data.shellProfiles.map((profile) => profile.path)
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
    if (!entry.isDirectory() || !entry.name.endsWith("-ssh-agent")) continue;
    const directory = join(paths.hostProxyRunRoot, entry.name);
    const text = tryReadText(join(directory, "worker.json"), defaultReadText);
    if (text === undefined) continue;
    const record = Schema.decodeUnknownOption(Schema.parseJson(AgentRelayWorkerRecord))(text);
    if (Option.isNone(record) || record.value.kind !== "ssh") continue;
    const app = { id: record.value.appId, root: record.value.appRoot };
    if (paths.agentRelayRunDir("ssh", app.id, app.root) !== directory) continue;
    await Effect.runPromise(
      cleanupAgentRelayState(app, { userDataRoot }, "ssh").pipe(
        Effect.provideService(PrivateFileAccessService, privateFileAccess),
      ),
    );
  }
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
    status: mode === "purge" ? "owned" : "manual",
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
  platform: ReturnType<typeof normalizeHostPlatform> = normalizeHostPlatform(),
): Promise<ReadonlyArray<UninstallPlanStep>> => {
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
    shellEntriesStep(path, exists, readText, mode),
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

  const steps: ReadonlyArray<UninstallPlanStep> = [
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
      ? [
          cgroupsDelegateStep(cgroupsDelegatePath, exists, readText),
          socketProxyHelperStep(
            {
              unitPaths: options.socketProxyUnitPaths ?? [...DEFAULT_SOCKET_PROXY_UNIT_PATHS],
              polkitPath: options.socketProxyPolkitPath ?? DEFAULT_SOCKET_PROXY_POLKIT_PATH,
            },
            { exists, readText },
          ),
        ]
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
      status: Either.match(
        inspectOwnedExecutable({ recordFile: paths.installRecordFile, platform: paths.platform }),
        {
          onLeft: (error) => (error.reason === "no-record" ? ("skipped" as const) : ("owned" as const)),
          onRight: () => "owned" as const,
        },
      ),
      detail:
        "Remove the install record last, only after executable and shell cleanup completed or were skipped.",
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
  const shellProfiles = uninstallShellProfiles(options);
  const recordFile = makeLandoPaths({ userDataRoot }).installRecordFile;
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
    if (step.id === "socket-proxy-helper") {
      if (step.status !== "owned") {
        executed.push({ ...step, outcome: outcomeForSkippedStep(step) });
        continue;
      }
      try {
        const outcome = await executeSocketProxyHelperStep({
          paths: {
            unitPaths: options.socketProxyUnitPaths ?? [...DEFAULT_SOCKET_PROXY_UNIT_PATHS],
            polkitPath: options.socketProxyPolkitPath ?? DEFAULT_SOCKET_PROXY_POLKIT_PATH,
          },
          io: { exists, readText },
          remove,
          ...(options.elevate === undefined ? {} : { elevate: options.elevate }),
        });
        executed.push({ ...step, outcome });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        executed.push({ ...step, outcome: "failed", error });
      }
      continue;
    }
    if (step.id === "shell-entries") {
      // keep-data leaves every block. Purge still strips readable profiles when
      // one sibling is unreadable; that sibling stays manual and holds the record.
      if (step.status !== "owned" && !(mode === "purge" && step.status === "manual")) {
        executed.push({ ...step, outcome: outcomeForSkippedStep(step) });
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
          const { content: rewritten, stripped } = stripLandoShellenvBlock(content);
          if (stripped) await writeText(profile, rewritten);
        }
        executed.push({ ...step, outcome: unresolved ? "manual" : "completed" });
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
      if (step.id === "installed-binary") {
        const current = installedBinaryStep(recordFile, step.target);
        if (current.status !== "owned") {
          executed.push({ ...current, outcome: outcomeForSkippedStep(current) });
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
          status: "manual",
          outcome: "manual",
          detail: "Preserve the install record until executable and shell cleanup is resolved.",
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
          status: "manual",
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
        if (binaryResolved) {
          await remove(userDataRoot);
          const deferred = executed.findIndex((entry) => entry.id === "user-data-root");
          const deferredStep = deferred === -1 ? undefined : executed[deferred];
          if (deferredStep?.outcome === "manual") {
            executed[deferred] = {
              ...deferredStep,
              status: "owned",
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

export const uninstall = (
  options: UninstallOptions = {},
): Effect.Effect<UninstallResult, never, PrivateFileAccessService> =>
  Effect.gen(function* () {
    const hostMaintenanceRegistry = yield* Effect.serviceOption(HostMaintenanceRegistry);
    const privilege = yield* Effect.serviceOption(PrivilegeService);
    const privateFileAccess = yield* PrivateFileAccessService;
    const elevate =
      options.elevate ??
      (privilege._tag === "Some"
        ? (command: ReadonlyArray<string>) => Effect.runPromise(privilege.value.elevate(command))
        : undefined);
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
      return yield* Effect.promise(() => executeUninstall(resolvedOptions, mode, hostMaintenanceRegistry));
    const steps = yield* Effect.promise(() => buildUninstallPlan(options, mode));
    return {
      dryRun,
      refused: !dryRun && !yes,
      mode,
      failed: false,
      steps,
    };
  });
