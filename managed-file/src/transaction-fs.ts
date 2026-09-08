import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { syncDirectory } from "@lando/state-store/atomic";
import { transactionError } from "./transaction-error.ts";
import type { Entry, FileState, Stage } from "./transaction-journal.ts";

export const digestOf = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;
export const statMaybe = async (path: string) => {
  try {
    return await lstat(path);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
};
export const ensureDirectory = async (path: string): Promise<void> => {
  const parent = dirname(path);
  if (parent !== path) await ensureDirectory(parent);
  const stats = await statMaybe(path);
  if (stats !== null) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw transactionError("path", "prepare", path);
    return;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause;
  }
  const created = await lstat(path);
  if (!created.isDirectory() || created.isSymbolicLink()) throw transactionError("path", "prepare", path);
  await syncDirectory(dirname(path));
};
export const canonicalRoot = async (path: string): Promise<string> => {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw transactionError("path", "prepare");
  return root;
};
export const targetPath = async (root: string, path: string): Promise<string> => {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw transactionError("path", "prepare", path);
  }
  if ((await realpath(root)) !== root) throw transactionError("path", "prepare", path);
  let parent = dirname(target);
  while (parent !== root) {
    const stats = await lstat(parent);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw transactionError("path", "prepare", path);
    parent = dirname(parent);
  }
  const stats = await statMaybe(target);
  if (stats !== null && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)) {
    throw transactionError("path", "prepare", path);
  }
  return target;
};

export const snapshot = async (path: string) => {
  const stats = await statMaybe(path);
  if (stats === null) return { state: { present: false } as const, bytes: new Uint8Array() };
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
    throw transactionError("path", "prepare");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== stats.dev || opened.ino !== stats.ino || opened.nlink !== 1)
      throw transactionError("conflict", "prepare");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw transactionError("conflict", "prepare");
    }
    return { state: { present: true, digest: digestOf(bytes), mode: opened.mode & 0o7777 } as const, bytes };
  } finally {
    await handle.close();
  }
};
export const sameState = (left: FileState, right: FileState): boolean =>
  left.present === right.present &&
  (!left.present || (right.present && left.digest === right.digest && left.mode === right.mode));

export const verifyState = async (root: string, entry: Entry, state: FileState): Promise<void> => {
  const path = await targetPath(root, entry.path);
  if (!sameState((await snapshot(path)).state, state))
    throw transactionError("conflict", "commit", entry.path);
};

const verifyPrivateFile = async (path: string, digest: string): Promise<void> => {
  const stats = await statMaybe(path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== "win32" && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()))
  )
    throw transactionError("conflict", "prepare");
  const read = await snapshot(path);
  if (!read.state.present || read.state.digest !== digest) throw transactionError("conflict", "prepare");
};

export const verifyBackup = async (root: string, entry: Entry): Promise<void> => {
  if (!entry.before.present) return;
  const path = await targetPath(root, entry.before.backup);
  await verifyPrivateFile(path, entry.before.digest);
};

export const createStage = async (
  path: string,
  bytes: Uint8Array,
  record: (stage: Stage) => void,
): Promise<void> => {
  const handle = await open(path, "wx", 0o600);
  try {
    const stats = await handle.stat();
    record({ path, dev: String(stats.dev), ino: String(stats.ino) });
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
};

export const ensureBackup = async (path: string, bytes: Uint8Array): Promise<void> => {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause;
  }
  await verifyPrivateFile(path, digestOf(bytes));
};

/**
 * Removes a stage only when it still proves this transaction's ownership: same
 * inode, same owner, and the exact bytes the journal recorded. A stage whose
 * identity or content drifted belongs to someone else and is preserved.
 */
export const removeRecordedStage = async (stage: Stage, digest: string): Promise<void> => {
  const stats = await statMaybe(stage.path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== "win32" && stats.uid !== process.getuid?.()) ||
    String(stats.dev) !== stage.dev ||
    String(stats.ino) !== stage.ino
  )
    return;
  const read = await snapshot(stage.path);
  if (!read.state.present || read.state.digest !== digest) return;
  await unlink(stage.path);
  await syncDirectory(dirname(stage.path));
};

/**
 * Completes a write whose stage rename landed but whose final mode never did.
 * The target must still be the renamed stage inode carrying the recorded after
 * digest at the stage's owner-only mode before the intended mode is applied.
 */
export const finishAppliedMode = async (root: string, entry: Entry): Promise<void> => {
  const stage = entry.stage;
  if (!entry.after.present || stage === undefined) throw transactionError("journal", "recover");
  const path = await targetPath(root, entry.path);
  const stats = await lstat(path);
  if (
    String(stats.dev) !== stage.dev ||
    String(stats.ino) !== stage.ino ||
    (process.platform !== "win32" && (stats.mode & 0o7777) !== 0o600)
  ) {
    throw transactionError("conflict", "recover", entry.path);
  }
  const read = await snapshot(path);
  if (!read.state.present || read.state.digest !== entry.after.digest)
    throw transactionError("conflict", "recover", entry.path);
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    await handle.chmod(entry.after.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  await verifyState(root, entry, entry.after);
};

export const mutateEntry = async (root: string, entry: Entry): Promise<void> => {
  await verifyState(root, entry, entry.before);
  const path = resolve(root, entry.path);
  if (entry.after.present) {
    const stage = entry.stage;
    if (stage === undefined) throw transactionError("journal", "commit");
    await targetPath(root, relative(root, stage.path));
    const stats = await lstat(stage.path);
    if (String(stats.dev) !== stage.dev || String(stats.ino) !== stage.ino) {
      throw transactionError("conflict", "commit", entry.path);
    }
    await verifyPrivateFile(stage.path, entry.after.digest);
    await verifyState(root, entry, entry.before);
    await verifyBackup(root, entry);
    await rename(stage.path, path);
    const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await handle.chmod(entry.after.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await verifyBackup(root, entry);
    await unlink(path);
  }
  await syncDirectory(dirname(path));
  await verifyState(root, entry, entry.after);
};
