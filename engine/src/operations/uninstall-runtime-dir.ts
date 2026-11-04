import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, readFile, readdir, readlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  managedPodmanChildEnv,
  managedPodmanGlobalArgs,
  managedPodmanOverlayEnv,
} from "@lando/container-runtime/podman/managed-invocation";
import {
  type ManagedPauseSeams,
  type ManagedRuntimeDirSeams,
  managedRuntimeDirForTeardown,
  prepareManagedRuntimeDir,
  terminateManagedPause,
} from "@lando/container-runtime/podman/managed-runtime-dir";
import { runProbe } from "@lando/sdk/probe";
import { Duration, Effect } from "effect";

import { leftoverUninstallRuntimeDirError } from "./uninstall-runtime-error";

const DELETED_EXE_SUFFIX = " (deleted)";
const MANAGED_PODMAN_UNSHARE_TIMEOUT_MS = 30_000;
const TERMINATE_WAIT_MS = 2_000;
const TERMINATE_POLL_MS = 50;

const normalizePathForContainment = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/u, "");

const isPathInside = (candidate: string, parent: string): boolean => {
  const left = normalizePathForContainment(resolve(candidate));
  const right = normalizePathForContainment(resolve(parent));
  return left === right || left.startsWith(`${right}/`);
};

const stripDeletedSuffix = (path: string): string =>
  path.endsWith(DELETED_EXE_SUFFIX) ? path.slice(0, -DELETED_EXE_SUFFIX.length) : path;

const resolvedPathCandidates = (raw: string): ReadonlyArray<string> => {
  const stripped = stripDeletedSuffix(raw);
  if (stripped.length === 0) return [];
  const candidates = [stripped];
  try {
    candidates.push(realpathSync(stripped));
  } catch {
    // Deleted or unreadable paths still match on the lexical candidate.
  }
  return candidates;
};

const pathIsUnderRuntimeBin = (raw: string, binDir: string): boolean =>
  resolvedPathCandidates(raw).some((candidate) => isPathInside(candidate, binDir));

const listNumericPids = async (): Promise<ReadonlyArray<number>> => {
  try {
    const entries = await readdir("/proc");
    return entries.flatMap((entry) => {
      if (!/^\d+$/u.test(entry)) return [];
      const pid = Number(entry);
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  } catch {
    return [];
  }
};

const processMatchesRuntimeBin = async (pid: number, binDir: string): Promise<boolean> => {
  try {
    const exe = await readlink(`/proc/${pid}/exe`);
    if (pathIsUnderRuntimeBin(exe, binDir)) return true;
  } catch {
    // Kernel threads and vanished pids have no exe symlink.
  }
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv0 = raw.split("\0")[0] ?? "";
    if (argv0.length > 0 && pathIsUnderRuntimeBin(argv0, binDir)) return true;
  } catch {
    // Cmdline can disappear between readdir and read.
  }
  return false;
};

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForTermination = async (pids: ReadonlyArray<number>): Promise<void> => {
  if (pids.length === 0) return;
  const maxAttempts = Math.ceil(TERMINATE_WAIT_MS / TERMINATE_POLL_MS) + 1;
  await Effect.runPromise(
    runProbe(
      {
        id: "uninstall-runtime-bin-terminate",
        policy: {
          maxAttempts,
          delay: Duration.millis(TERMINATE_POLL_MS),
          timeout: Duration.millis(TERMINATE_WAIT_MS + TERMINATE_POLL_MS),
        },
        classify: {
          success: (done: unknown) => (done === true ? "green" : "red"),
          failure: () => "red" as const,
        },
      },
      Effect.sync(() => pids.every((pid) => !pidIsAlive(pid))),
    ).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    ),
  );
};

const terminateWindowsRuntimeBinProcesses = async (binDir: string): Promise<void> => {
  // Query executable paths, rather than process names: other Podman installations
  // can have helpers with the same name.
  const script = `
$ErrorActionPreference = 'Stop'
$bin = [IO.Path]::GetFullPath($env:LANDO_RUNTIME_BIN_DIR).TrimEnd('\\') + '\\'
$matches = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)
})
foreach ($item in $matches) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
  if ($current -and $current.ExecutablePath -and $current.ExecutablePath.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)) {
    try { Stop-Process -Id $item.ProcessId -ErrorAction Stop }
    catch {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
      if ($current -and $current.ExecutablePath -and $current.ExecutablePath.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)) { throw }
    }
  }
}
foreach ($item in $matches) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
  if ($current -and $current.ExecutablePath -and $current.ExecutablePath.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)) {
    try { Wait-Process -Id $item.ProcessId -Timeout 2 -ErrorAction Stop }
    catch {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
      if ($current -and $current.ExecutablePath -and $current.ExecutablePath.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)) { throw }
    }
  }
}
`;
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: windowsSpawnEnv({ LANDO_RUNTIME_BIN_DIR: binDir }),
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Could not stop Lando-managed runtime processes (${stderr.trim() || `exit ${exitCode}`}).`,
    );
  }
};

export const defaultTerminateRuntimeBinProcesses = async (runtimeDir: string): Promise<void> => {
  const binDir = join(runtimeDir, "bin");
  if (process.platform === "win32") return terminateWindowsRuntimeBinProcesses(binDir);
  if (process.platform !== "linux") return;
  const selfPid = process.pid;
  const matches: number[] = [];
  for (const pid of await listNumericPids()) {
    if (pid === 1 || pid === selfPid) continue;
    if (await processMatchesRuntimeBin(pid, binDir)) matches.push(pid);
  }
  for (const pid of matches) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Best-effort: the pid may have exited between match and signal.
    }
  }
  if (matches.length > 0) await waitForTermination(matches);
};

export const chmodTreeUserWritable = async (root: string): Promise<void> => {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(root);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  try {
    await chmod(root, st.mode | 0o200);
  } catch {
    // Subuid-owned entries stay for managed unshare / the leftover existence check.
  }
  if (!st.isDirectory()) return;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    await chmodTreeUserWritable(join(root, name));
  }
};

export const managedRuntimeConfigDir = (runtimeDir: string): string => join(runtimeDir, "config");

export const managedPodmanUnshareRmInvocation = (
  runtimeDir: string,
  target: string = runtimeDir,
  options: {
    readonly privateRuntimeDir?: string;
    readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
} => {
  const configDir = managedRuntimeConfigDir(runtimeDir);
  const binDir = join(runtimeDir, "bin");
  const overlay = managedPodmanOverlayEnv({
    runtimeConfigDir: configDir,
    runtimeBinDir: binDir,
    ...(options.hostEnv?.PATH === undefined ? {} : { hostPath: options.hostEnv.PATH }),
    ...(options.privateRuntimeDir === undefined ? {} : { privateRuntimeDir: options.privateRuntimeDir }),
  });
  return {
    command: join(binDir, "podman"),
    args: [
      ...managedPodmanGlobalArgs({
        runtimeStorageDir: join(runtimeDir, "storage"),
        runtimeRunDir: join(runtimeDir, "run"),
        runtimeConfigDir: configDir,
        runtimeBinDir: binDir,
      }),
      "unshare",
      "rm",
      "-rf",
      target,
    ],
    env: managedPodmanChildEnv(overlay, options.hostEnv ?? {}),
  };
};

/** Windows PowerShell helper still needs a full host env; Linux managed spawns never use this. */
const windowsSpawnEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
};

export const runManagedPodmanUnshareRm = async (
  command: string,
  args: ReadonlyArray<string>,
  childEnv: Readonly<Record<string, string>> = {},
): Promise<void> => {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...childEnv },
  });
  const timeout = setTimeout(() => {
    proc.kill();
  }, MANAGED_PODMAN_UNSHARE_TIMEOUT_MS);
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(stderr.trim() || `managed podman unshare rm failed with exit ${String(exitCode)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const defaultRemove = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

export interface RemoveRuntimeDirDeps {
  readonly unshareRm?: (
    command: string,
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly removeTree?: (path: string) => Promise<void>;
  readonly exists?: (path: string) => boolean;
  readonly terminate?: (runtimeDir: string) => Promise<void>;
  /**
   * Prepare (create/verify) the private runtime dir before unshare. Production
   * default is prepareManagedRuntimeDir. Tests inject to avoid /run writes.
   */
  readonly preparePrivateRuntimeDir?: (runtimeDir: string) => Promise<string>;
  /** Resolve the private runtime dir before the runtime tree is removed (tests inject). */
  readonly resolvePrivateRuntimeDir?: (runtimeDir: string) => Promise<string | undefined>;
  readonly terminatePause?: (privateRuntimeDir: string) => Promise<void>;
  readonly removePrivateRuntimeDir?: (privateRuntimeDir: string) => Promise<void>;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly runtimeDirSeams?: ManagedRuntimeDirSeams;
  readonly pauseSeams?: ManagedPauseSeams;
}

export const defaultRemoveRuntimeDir = async (
  path: string,
  deps: RemoveRuntimeDirDeps = {},
): Promise<void> => {
  const exists = deps.exists ?? existsSync;
  const unshareRm = deps.unshareRm ?? runManagedPodmanUnshareRm;
  const removeTree = deps.removeTree ?? defaultRemove;
  const terminate = deps.terminate ?? defaultTerminateRuntimeBinProcesses;
  const hostEnv = deps.hostEnv ?? process.env;
  const defaultPrepare = (runtimeDir: string): Promise<string> =>
    Effect.runPromise(
      prepareManagedRuntimeDir(runtimeDir, {
        ...(deps.runtimeDirSeams ?? {}),
        providerId: "lando",
      }),
    );
  const defaultResolve = (runtimeDir: string): Promise<string | undefined> =>
    Effect.runPromise(managedRuntimeDirForTeardown(runtimeDir, deps.runtimeDirSeams ?? {}));
  const terminatePause =
    deps.terminatePause ??
    ((privateRuntimeDir: string) =>
      Effect.runPromise(terminateManagedPause(privateRuntimeDir, deps.pauseSeams ?? {})));
  const removePrivate = deps.removePrivateRuntimeDir ?? defaultRemove;

  // Read before the tree goes: the launch record naming the service's private dir lives under it.
  const launchedRuntimeDir =
    process.platform === "linux" ? await (deps.resolvePrivateRuntimeDir ?? defaultResolve)(path) : undefined;
  let privateRuntimeDir = launchedRuntimeDir;

  await terminate(path);
  await chmodTreeUserWritable(path);

  const managedPodman = join(path, "bin", "podman");
  let unshareFailure: unknown;
  if (process.platform === "linux" && exists(managedPodman)) {
    const prepare = deps.preparePrivateRuntimeDir ?? defaultPrepare;
    const storage = join(path, "storage");
    if (exists(storage)) {
      privateRuntimeDir = await prepare(path);
      const storageInvocation = managedPodmanUnshareRmInvocation(path, storage, {
        hostEnv,
        privateRuntimeDir,
      });
      try {
        await unshareRm(storageInvocation.command, storageInvocation.args, storageInvocation.env);
      } catch (cause) {
        unshareFailure = cause;
      }
    }
    if (exists(path)) {
      privateRuntimeDir = await prepare(path);
      const invocation = managedPodmanUnshareRmInvocation(path, path, {
        hostEnv,
        privateRuntimeDir,
      });
      try {
        await unshareRm(invocation.command, invocation.args, invocation.env);
      } catch (cause) {
        unshareFailure = cause;
      }
    }
  }

  if (exists(path)) {
    try {
      await removeTree(path);
    } catch (cause) {
      if (exists(path)) throw leftoverUninstallRuntimeDirError(path, exists, cause);
    }
  }
  if (exists(path)) {
    throw leftoverUninstallRuntimeDirError(path, exists, unshareFailure);
  }

  // `unshare` may have started a pause in the current private dir; the service's own may differ.
  for (const dir of new Set([launchedRuntimeDir, privateRuntimeDir])) {
    if (dir === undefined) continue;
    await terminatePause(dir);
    await removePrivate(dir);
  }

  await terminate(path);
};
