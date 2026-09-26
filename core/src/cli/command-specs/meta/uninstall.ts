import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { Flags } from "../../spec/metadata";

import {
  type DiscoveredApp,
  type UninstallOptions,
  type UninstallResult,
  UninstallResultSchema,
  uninstall,
} from "@lando/engine/operations/uninstall";
import { readAppliedPlansFromUserData } from "../../commands/list-discovery";
import { renderUninstallResult } from "../../commands/uninstall";
import type { LandoCommandSpec } from "../../spec/command-base";

const CONTAINER_RUNTIMES = [
  { cmd: "docker", providerId: "docker" },
  { cmd: "podman", providerId: "lando" },
] as const;

type RuntimeProbe = {
  readonly cmd: string;
  readonly providerId: string;
  readonly argsPrefix: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
};

const pathRuntime = (cmd: string, providerId: string): RuntimeProbe => ({
  cmd,
  providerId,
  argsPrefix: [],
});

const managedLandoRuntime = (
  userDataRoot: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeProbe => {
  const paths = makeLandoPaths({ userDataRoot });
  if (platform === "win32") {
    return {
      cmd: join(paths.runtimeBinDir, "podman.exe"),
      providerId: "lando",
      argsPrefix: ["--connection", "lando-root"],
      env: {
        CONTAINERS_CONF: join(paths.runtimeConfigDir, "containers.conf"),
        CONTAINERS_REGISTRIES_CONF: join(paths.runtimeConfigDir, "registries.conf"),
        XDG_CONFIG_HOME: paths.runtimeConfigDir,
      },
    };
  }
  return {
    cmd: join(paths.runtimeBinDir, "podman"),
    providerId: "lando",
    argsPrefix: [
      "--root",
      paths.runtimeStorageDir,
      "--runroot",
      paths.runtimeRunDir,
      "--config",
      paths.runtimeConfigDir,
      "--storage-opt",
      `overlay.mount_program=${paths.runtimeBinDir}/fuse-overlayfs`,
    ],
    env: {
      CONTAINERS_CONF: join(paths.runtimeConfigDir, "containers.conf"),
      CONTAINERS_REGISTRIES_CONF: join(paths.runtimeConfigDir, "registries.conf"),
      XDG_CONFIG_HOME: paths.runtimeConfigDir,
    },
  };
};

const runRuntime = async (
  execFileAsync: (
    file: string,
    args: ReadonlyArray<string>,
    options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv },
  ) => Promise<{ readonly stdout: string }>,
  runtime: RuntimeProbe,
  args: ReadonlyArray<string>,
  timeout: number,
): Promise<{ readonly stdout: string }> =>
  execFileAsync(runtime.cmd, [...runtime.argsPrefix, ...args], {
    timeout,
    ...(runtime.env === undefined ? {} : { env: { ...process.env, ...runtime.env } }),
  });

// core4 apps carry dev.lando.app; com.lando.app covers Lando 3 leftovers.
const LANDO_APP_LABELS = ["dev.lando.app", "com.lando.app"] as const;
const RUNTIME_PROBE_TIMEOUT_MS = 2_000;
const RUNTIME_QUERY_TIMEOUT_MS = 5_000;
const RUNTIME_CLEANUP_TIMEOUT_MS = 60_000;
const SYNC_KIND_LABEL = "dev.lando.sync.kind";

const assertNoPersistedAcceleratedSync = async (userDataRoot: string): Promise<void> => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { AppPlan } = await import("@lando/sdk/schema");
  const { Either, Schema } = await import("effect");
  const plansDir = join(
    makeLandoPaths({ userDataRoot }).pluginsDir,
    "@lando",
    "provider-lando",
    "applied-plans",
  );
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir(plansDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      "Cannot inspect saved Lando plans before purge; preserve the managed runtime and retry.",
      { cause },
    );
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const envelope: unknown = JSON.parse(await readFile(join(plansDir, entry), "utf8"));
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope))
        throw new Error("invalid envelope");
      const plan: unknown = Reflect.get(envelope, "data");
      if (
        Reflect.get(envelope, "version") !== 1 ||
        typeof plan !== "object" ||
        plan === null ||
        Array.isArray(plan)
      )
        throw new Error("invalid plan");
      const fileSync = Reflect.get(plan, "fileSync");
      const services = Reflect.get(plan, "services");
      const reservedGlobalWithoutSessions = Reflect.get(plan, "id") === "global" && fileSync === undefined;
      if (
        (!Array.isArray(fileSync) && !reservedGlobalWithoutSessions) ||
        typeof services !== "object" ||
        services === null ||
        Array.isArray(services)
      )
        throw new Error("invalid sync fields");
      if (!reservedGlobalWithoutSessions && Either.isLeft(Schema.decodeUnknownEither(AppPlan)(plan)))
        throw new Error("invalid app plan");
      if (Array.isArray(fileSync) && fileSync.length > 0) throw new Error("accelerated sync plan");
      for (const service of Object.values(services)) {
        if (typeof service !== "object" || service === null || Array.isArray(service))
          throw new Error("invalid service");
        const appMount = Reflect.get(service, "appMount");
        const mounts = Reflect.get(service, "mounts");
        if (reservedGlobalWithoutSessions && (mounts !== undefined || appMount !== undefined))
          throw new Error("invalid reserved global plan");
        if (
          appMount?.realization === "accelerated" ||
          (Array.isArray(mounts) && mounts.some((mount) => mount?.realization === "accelerated"))
        )
          throw new Error("accelerated sync mount");
      }
    } catch (cause) {
      throw new Error(
        `Cannot safely purge while saved plan ${entry} contains accelerated or unreadable sync state. Run lando stop to flush, then lando destroy --volumes to remove verified sync resources before retrying.`,
        { cause },
      );
    }
  }
};

const makeListDiscoveredApps =
  (): ((userDataRoot: string, userCacheRoot: string) => Promise<ReadonlyArray<DiscoveredApp>>) =>
  async (userDataRoot: string, _userCacheRoot: string): Promise<ReadonlyArray<DiscoveredApp>> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const availableRuntimes: RuntimeProbe[] = [];
    for (const runtime of CONTAINER_RUNTIMES) {
      const probe = pathRuntime(runtime.cmd, runtime.providerId);
      try {
        await runRuntime(execFileAsync, probe, ["--version"], RUNTIME_PROBE_TIMEOUT_MS);
        availableRuntimes.push(probe);
      } catch {
        // Runtime not installed; only installed runtimes are queried below.
      }
    }
    const managed = managedLandoRuntime(userDataRoot);
    if (!availableRuntimes.some((runtime) => runtime.cmd === managed.cmd)) {
      try {
        await runRuntime(execFileAsync, managed, ["--version"], RUNTIME_PROBE_TIMEOUT_MS);
        availableRuntimes.push(managed);
      } catch {
        // Managed runtime not installed.
      }
    }
    // Fail closed only when a user app is recorded and cannot be checked.
    // The reserved global app is setup state, not a running-user-app signal.
    // Fresh roots or setup-only state cannot indicate running user apps.
    if (availableRuntimes.length === 0) {
      const recorded = await readAppliedPlansFromUserData(userDataRoot);
      if (recorded.every((app) => app.appId === "global")) return [];
      throw new Error("neither docker nor podman is available to verify running Lando apps");
    }

    const apps: DiscoveredApp[] = [];
    const errors: string[] = [];

    for (const runtime of availableRuntimes) {
      const runningAppIds = new Set<string>();
      for (const label of LANDO_APP_LABELS) {
        try {
          const { stdout } = await runRuntime(
            execFileAsync,
            runtime,
            ["ps", "--filter", `label=${label}`, "--format", `{{.Label "${label}"}}`],
            RUNTIME_QUERY_TIMEOUT_MS,
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

const assertNoDurableMutagenSessions = async (userDataRoot: string): Promise<void> => {
  const { readFile } = await import("node:fs/promises");
  const ledgerPath = join(
    makeLandoPaths({ userDataRoot }).pluginsDir,
    "@lando",
    "file-sync-mutagen",
    "sessions",
    "mutagen.json",
  );
  let content: string;
  try {
    content = await readFile(ledgerPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      "Cannot inspect durable Mutagen session state before purge; preserve the managed runtime and retry.",
      { cause },
    );
  }
  try {
    const envelope: unknown = JSON.parse(content);
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      Array.isArray(envelope) ||
      Reflect.get(envelope, "version") !== 1
    )
      throw new Error("invalid ledger envelope");
    const data: unknown = Reflect.get(envelope, "data");
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new Error("invalid ledger data");
    const sessions: unknown = Reflect.get(data, "sessions");
    if (!Array.isArray(sessions)) throw new Error("invalid sessions");
    if (sessions.length > 0) throw new Error("durable sessions remain");
  } catch (cause) {
    throw new Error(
      "Cannot safely purge while durable Mutagen session state is active or unreadable. Run lando stop to flush, then lando destroy --volumes before retrying.",
      { cause },
    );
  }
};

// Sweeps every installed runtime rather than only the discovered apps:
// leftover stopped containers, networks, and volumes must go too (#771).
export const makeCleanupDiscoveredApps =
  (
    userDataRoot?: string,
    execFileAsyncOverride?: (
      file: string,
      args: ReadonlyArray<string>,
      options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv },
    ) => Promise<{ readonly stdout: string }>,
    platform: NodeJS.Platform = process.platform,
  ): ((apps: ReadonlyArray<DiscoveredApp>) => Promise<void>) =>
  async (_apps: ReadonlyArray<DiscoveredApp>): Promise<void> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = execFileAsyncOverride ?? promisify(execFile);

    const errors: string[] = [];

    const cleanupRuntimes: RuntimeProbe[] = CONTAINER_RUNTIMES.map((runtime) =>
      pathRuntime(runtime.cmd, runtime.providerId),
    );
    const dataRoot = userDataRoot ?? makeLandoPaths().roots.userDataRoot;
    const managed = managedLandoRuntime(dataRoot, platform);
    if (!cleanupRuntimes.some((runtime) => runtime.cmd === managed.cmd)) {
      cleanupRuntimes.push(managed);
    }
    const availableRuntimes: RuntimeProbe[] = [];
    for (const runtime of cleanupRuntimes) {
      try {
        await runRuntime(execFileAsync, runtime, ["--version"], RUNTIME_PROBE_TIMEOUT_MS);
        availableRuntimes.push(runtime);
      } catch {
        if (platform === "win32" && runtime.cmd === managed.cmd) {
          const { access } = await import("node:fs/promises");
          try {
            await access(makeLandoPaths({ userDataRoot: dataRoot }).runtimeBinDir);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
              const { classifyManagedProviderMachine } = await import(
                "@lando/engine/runtime/managed-provider-machine"
              );
              const machine = classifyManagedProviderMachine(dataRoot, undefined, "win32");
              if (machine.ownership === "absent") continue;
              throw new Error(
                "Cannot inspect the recorded Windows managed machine before purge because its Podman binary is missing; preserve the machine and state.",
                { cause },
              );
            }
            throw new Error(
              "Cannot inspect the Windows managed runtime before purge; preserve its machine and state.",
              { cause },
            );
          }
          throw new Error(
            "Cannot query the installed Windows managed Podman binary before purge; preserve its machine and state.",
          );
        }
        // Runtime not installed; nothing to inspect or sweep.
      }
    }

    // Inspect all runtimes before sweeping any of them. A stopped helper and
    // an orphaned sync volume can both hold the only copy of recent app data.
    if (platform === "win32") {
      await assertNoPersistedAcceleratedSync(dataRoot);
      await assertNoDurableMutagenSessions(dataRoot);
    }
    for (const runtime of platform === "win32" ? availableRuntimes : []) {
      try {
        const [containers, volumes] = await Promise.all([
          runRuntime(
            execFileAsync,
            runtime,
            ["ps", "-a", "--filter", `label=${SYNC_KIND_LABEL}=helper`, "--format", "{{.ID}}"],
            RUNTIME_QUERY_TIMEOUT_MS,
          ),
          runRuntime(
            execFileAsync,
            runtime,
            ["volume", "ls", "--filter", `label=${SYNC_KIND_LABEL}=volume`, "--format", "{{.Name}}"],
            RUNTIME_QUERY_TIMEOUT_MS,
          ),
        ]);
        if (containers.stdout.trim() || volumes.stdout.trim())
          throw new Error(
            "accelerated sync helper or volume exists; run lando stop to flush, then lando destroy --volumes to remove verified sync resources before purging",
          );
        if (runtime.cmd === managed.cmd) {
          const [allContainers, allVolumes] = await Promise.all([
            runRuntime(
              execFileAsync,
              runtime,
              ["ps", "-a", "--format", "{{.Names}}"],
              RUNTIME_QUERY_TIMEOUT_MS,
            ),
            runRuntime(
              execFileAsync,
              runtime,
              ["volume", "ls", "--format", "{{.Name}}"],
              RUNTIME_QUERY_TIMEOUT_MS,
            ),
          ]);
          const possibleHelper = allContainers.stdout
            .split(/\r?\n/u)
            .some((name) => /^lando-sync-.+-[a-f0-9]{16}$/u.test(name.trim()));
          const possibleVolume = allVolumes.stdout
            .split(/\r?\n/u)
            .some((name) => /-(?:app-mount|mount-[0-9]+)$/u.test(name.trim()));
          if (possibleHelper || possibleVolume)
            throw new Error(
              "possible unlabeled Lando sync helper or volume exists; inspect its data before purging",
            );
        }
      } catch (cause) {
        throw new Error(
          `Cannot safely purge ${runtime.cmd}: ${cause instanceof Error ? cause.message : String(cause)}. Managed runtime, volumes, and state were preserved.`,
          { cause },
        );
      }
    }

    for (const runtime of availableRuntimes) {
      // Stop and remove every Lando-labeled container, running or stopped.
      for (const label of LANDO_APP_LABELS) {
        try {
          const { stdout } = await runRuntime(
            execFileAsync,
            runtime,
            ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.ID}}"],
            RUNTIME_QUERY_TIMEOUT_MS,
          );
          const containerIds = stdout
            .trim()
            .split("\n")
            .filter((id) => id.length > 0);
          if (containerIds.length === 0) continue;

          try {
            await runRuntime(execFileAsync, runtime, ["stop", ...containerIds], RUNTIME_CLEANUP_TIMEOUT_MS);
          } catch {
            // Containers may already be stopped; forced removal below is the real gate.
          }
          await runRuntime(execFileAsync, runtime, ["rm", "-f", ...containerIds], RUNTIME_CLEANUP_TIMEOUT_MS);
        } catch (cause) {
          errors.push(`${runtime.cmd} (${label}): ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      // Prune unused Lando networks and volumes; best-effort.
      try {
        await runRuntime(
          execFileAsync,
          runtime,
          ["network", "prune", "-f", "--filter", "label=dev.lando.network=true"],
          RUNTIME_CLEANUP_TIMEOUT_MS,
        );
      } catch {
        // Networks still attached to containers are skipped by prune anyway.
      }
      try {
        await runRuntime(
          execFileAsync,
          runtime,
          ["volume", "prune", "-f", "--filter", "label=dev.lando.volume=true"],
          RUNTIME_CLEANUP_TIMEOUT_MS,
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
        : makeCleanupDiscoveredApps(
            typeof extra._userDataRoot === "string" ? extra._userDataRoot : undefined,
          );
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
      ? {
          elevate: extra._elevate as NonNullable<UninstallOptions["elevate"]>,
        }
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
  successExitCode: (result) => (result.refused || result.failed ? 1 : undefined),
  render: (result, _input, ctx) => renderUninstallResult(result as UninstallResult, ctx),
};
