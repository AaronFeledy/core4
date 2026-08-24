import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, readFile, readdir, readlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  const deadline = Date.now() + TERMINATE_WAIT_MS;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidIsAlive(pid))) return;
    await Bun.sleep(TERMINATE_POLL_MS);
  }
};

export const defaultTerminateRuntimeBinProcesses = async (runtimeDir: string): Promise<void> => {
  if (process.platform !== "linux") return;
  const binDir = join(runtimeDir, "bin");
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
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
} => {
  const configDir = managedRuntimeConfigDir(runtimeDir);
  return {
    command: join(runtimeDir, "bin", "podman"),
    args: ["--config", configDir, "unshare", "rm", "-rf", target],
    env: {
      CONTAINERS_CONF: join(configDir, "containers.conf"),
    },
  };
};

const spawnEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
};

export const runManagedPodmanUnshareRm = async (
  command: string,
  args: ReadonlyArray<string>,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<void> => {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv(extraEnv),
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
}

export const defaultRemoveRuntimeDir = async (
  path: string,
  deps: RemoveRuntimeDirDeps = {},
): Promise<void> => {
  const exists = deps.exists ?? existsSync;
  const unshareRm = deps.unshareRm ?? runManagedPodmanUnshareRm;
  const removeTree = deps.removeTree ?? defaultRemove;
  const terminate = deps.terminate ?? defaultTerminateRuntimeBinProcesses;

  await terminate(path);
  await chmodTreeUserWritable(path);

  const managedPodman = join(path, "bin", "podman");
  if (process.platform === "linux" && exists(managedPodman)) {
    const storage = join(path, "storage");
    if (exists(storage)) {
      const storageInvocation = managedPodmanUnshareRmInvocation(path, storage);
      try {
        await unshareRm(storageInvocation.command, storageInvocation.args, storageInvocation.env);
      } catch {
        // leftover presence fails closed below
      }
    }
    if (exists(path)) {
      const invocation = managedPodmanUnshareRmInvocation(path);
      try {
        await unshareRm(invocation.command, invocation.args, invocation.env);
      } catch {
        // leftover presence fails closed below
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
    throw leftoverUninstallRuntimeDirError(path, exists);
  }
  await terminate(path);
};
