import { constants, existsSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isErrnoCode } from "@lando/sdk/errors";
import { syncDirectory } from "@lando/state-store/atomic";
import { ManagedFileTransactionError, transactionError } from "./transaction-error.ts";
import type { DirectoryPolicy } from "./transaction-journal.ts";
import { statMaybe } from "./transaction-private-file.ts";

/** Linux directory-fd links. Absent on Windows and macOS; those kernels use path link plus an inode recheck. */
const directoryFdLinks = existsSync("/proc/self/fd");
type Phase = ManagedFileTransactionError["phase"];

export interface CreateDestination {
  readonly relativePath: string;
  readonly target: string;
  readonly stagePath: string;
  readonly missingParents: readonly string[];
}

const rejectPath = (phase: Phase, path: string): never => {
  throw transactionError("path", phase, path);
};

const contained = async (root: string, requested: string, phase: Phase): Promise<string> => {
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (isAbsolute(requested) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    rejectPath(phase, requested);
  }
  if ((await realpath(root)) !== root) rejectPath(phase, requested);
  return target;
};

export const resolveJournalPath = async (root: string, requested: string, phase: Phase): Promise<string> => {
  const target = await contained(root, requested, phase);
  let cursor = root;
  for (const part of relative(root, dirname(target)).split(sep)) {
    if (part === "") continue;
    cursor = join(cursor, part);
    const stats = await statMaybe(cursor);
    if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw transactionError("conflict", phase, requested);
    }
  }
  if ((await realpath(dirname(target))) !== dirname(target)) {
    throw transactionError("conflict", phase, requested);
  }
  return target;
};

/**
 * Plans one create without creating parents. The stage stays on an existing
 * real directory inside the app root so prepare remains byte-only.
 */
export const planCreateDestination = async (
  root: string,
  requestedPath: string,
  stageName: { readonly id: string; readonly index: number },
): Promise<CreateDestination> => {
  const target = await contained(root, requestedPath, "prepare");
  const relativePath = relative(root, target);
  const parts = relativePath.split(sep);
  const missingParents: string[] = [];
  let cursor = root;
  let missingSeen = false;
  for (const part of parts.slice(0, -1)) {
    if (part === "" || part === "." || part === "..") rejectPath("prepare", requestedPath);
    cursor = join(cursor, part);
    if (missingSeen) {
      missingParents.push(relative(root, cursor));
      continue;
    }
    const stats = await statMaybe(cursor);
    if (stats === null) {
      missingSeen = true;
      missingParents.push(relative(root, cursor));
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) rejectPath("prepare", requestedPath);
  }
  const leaf = parts.at(-1);
  if (leaf === undefined || leaf === "" || leaf === "." || leaf === "..")
    rejectPath("prepare", requestedPath);
  const existing = await statMaybe(target);
  if (existing !== null) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      rejectPath("prepare", requestedPath);
    throw transactionError("conflict", "prepare", requestedPath);
  }
  const firstMissing = missingParents[0];
  const stageDirectory = firstMissing === undefined ? dirname(target) : dirname(resolve(root, firstMissing));
  const stagePath =
    stageDirectory === dirname(target)
      ? `${target}.lando-stage.${stageName.id}`
      : join(stageDirectory, `.lando-stage.${stageName.id}.${stageName.index}`);
  return { relativePath, target, stagePath, missingParents };
};

export const openPinnedDirectory = async (
  path: string,
  phase: Phase,
  display: string,
): Promise<FileHandle> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      await handle.close();
      throw transactionError("conflict", phase, display);
    }
    return handle;
  } catch (cause) {
    if (cause instanceof ManagedFileTransactionError) throw cause;
    if (isErrnoCode(cause, "ELOOP") || isErrnoCode(cause, "ENOTDIR") || isErrnoCode(cause, "ENOENT")) {
      throw transactionError("conflict", phase, display);
    }
    throw cause;
  }
};

export const pinnedChildPath = (fd: number, name: string): string | undefined => {
  if (!directoryFdLinks || name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
  return `/proc/self/fd/${fd}/${name}`;
};

/** Linux fsyncs this directory fd. Windows delegates to `syncDirectory`, which does not fsync directories. */
export const syncPinnedDirectory = async (directory: FileHandle, path: string): Promise<void> => {
  if (process.platform === "win32") {
    await syncDirectory(path);
    return;
  }
  await directory.sync();
};

const singleName = (path: string, phase: Phase, display: string): string => {
  const name = basename(path);
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw transactionError("journal", phase, display);
  }
  return name;
};

/**
 * Creates only the journaled missing parents, one level at a time. An existing
 * real directory is reused and not chmodded. A symlink is left untouched.
 */
export const ensureDirectoryPolicy = async (
  root: string,
  policy: readonly DirectoryPolicy[] | undefined,
  phase: Phase,
): Promise<void> => {
  for (const directory of policy ?? []) {
    const absolute = await resolveJournalPath(root, directory.path, phase);
    const name = singleName(absolute, phase, directory.path);
    const parent = await openPinnedDirectory(dirname(absolute), phase, directory.path);
    try {
      const existing = await statMaybe(absolute);
      if (existing !== null) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw transactionError("conflict", phase, directory.path);
        }
        continue;
      }
      const via = pinnedChildPath(parent.fd, name) ?? absolute;
      let created = false;
      try {
        await mkdir(via, { mode: 0o755 });
        created = true;
      } catch (cause) {
        if (!isErrnoCode(cause, "EEXIST")) throw cause;
      }
      const visible = await lstat(absolute);
      if (!visible.isDirectory() || visible.isSymbolicLink()) {
        throw transactionError("conflict", phase, directory.path);
      }
      if (created) {
        const createdStats = await lstat(via);
        if (createdStats.dev !== visible.dev || createdStats.ino !== visible.ino) {
          throw transactionError("conflict", phase, directory.path);
        }
        if (process.platform !== "win32") {
          const child = await openPinnedDirectory(absolute, phase, directory.path);
          try {
            await child.chmod(0o755);
            await syncPinnedDirectory(child, absolute);
          } finally {
            await child.close();
          }
        }
      }
      await syncPinnedDirectory(parent, dirname(absolute));
    } finally {
      await parent.close();
    }
  }
};

/** Missing parents count as absence. A symlink or occupied leaf is a conflict and is not replaced. */
export const assertCreateAbsent = async (root: string, requestedPath: string): Promise<void> => {
  const target = await contained(root, requestedPath, "commit");
  const parts = relative(root, target).split(sep);
  let cursor = root;
  let missing = false;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    if (missing) continue;
    const stats = await statMaybe(cursor);
    if (stats === null) {
      missing = true;
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw transactionError("conflict", "commit", requestedPath);
  }
  if ((await statMaybe(target)) !== null) throw transactionError("conflict", "commit", requestedPath);
};
