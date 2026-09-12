import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { syncDirectory } from "@lando/state-store/atomic";
import { type PrivateFileAccess, PrivateFileAccessError } from "@lando/state-store/private-file-access";
import { transactionError } from "./transaction-error.ts";
import type { Entry, FileState, Stage } from "./transaction-journal.ts";
import { createPrivateFile, hasCode, statMaybe, targetPath } from "./transaction-private-file.ts";

export { canonicalRoot, ensureDirectory, statMaybe, targetPath } from "./transaction-private-file.ts";

export const digestOf = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

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
export const sameState = (left: FileState, right: FileState): boolean => {
  // Windows chmod only controls writability; stat synthesizes the other permission bits.
  const modeMask = process.platform === "win32" ? 0o200 : 0o7777;
  return (
    left.present === right.present &&
    (!left.present ||
      (right.present && left.digest === right.digest && (left.mode & modeMask) === (right.mode & modeMask)))
  );
};

export const verifyState = async (root: string, entry: Entry, state: FileState): Promise<void> => {
  const path = await targetPath(root, entry.path);
  if (!sameState((await snapshot(path)).state, state))
    throw transactionError("conflict", "commit", entry.path);
};

const verifyPrivateFile = async (
  path: string,
  digest: string,
  privateFileAccess: PrivateFileAccess,
): Promise<void> => {
  const stats = await statMaybe(path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== "win32" && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()))
  )
    throw transactionError("conflict", "prepare");
  try {
    await privateFileAccess.verify(path);
  } catch (cause) {
    if (cause instanceof PrivateFileAccessError) throw transactionError("conflict", "prepare", path);
    throw cause;
  }
  const read = await snapshot(path);
  if (!read.state.present || read.state.digest !== digest) throw transactionError("conflict", "prepare");
};

export const verifyBackup = async (
  root: string,
  entry: Entry,
  privateFileAccess: PrivateFileAccess,
): Promise<void> => {
  if (!entry.before.present) return;
  const path = await targetPath(root, entry.before.backup);
  await verifyPrivateFile(path, entry.before.digest, privateFileAccess);
};

export interface CreateStageOptions {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly record: (stage: Stage) => void;
  readonly privateFileAccess: PrivateFileAccess;
}

export const createStage = async (options: CreateStageOptions): Promise<void> => {
  await createPrivateFile({
    path: options.path,
    bytes: options.bytes,
    statMaybe,
    privateFileAccess: options.privateFileAccess.enforce,
    record: (identity) =>
      options.record({ path: options.path, dev: String(identity.dev), ino: String(identity.ino) }),
  });
};

export interface EnsureBackupOptions {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly privateFileAccess: PrivateFileAccess;
}

export const ensureBackup = async (options: EnsureBackupOptions): Promise<void> => {
  try {
    await createPrivateFile({
      path: options.path,
      bytes: options.bytes,
      statMaybe,
      privateFileAccess: options.privateFileAccess.enforce,
    });
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause;
  }
  await verifyPrivateFile(options.path, digestOf(options.bytes), options.privateFileAccess);
};

/**
 * Removes a stage only when it still proves this transaction's ownership: same
 * inode, same owner, and the exact bytes the journal recorded. A stage whose
 * identity or content drifted belongs to someone else and is preserved.
 */
export const removeRecordedStage = async (
  stage: Stage,
  digest: string,
  privateFileAccess: PrivateFileAccess,
): Promise<void> => {
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
  await privateFileAccess.verify(stage.path);
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
export const finishAppliedMode = async (
  root: string,
  entry: Entry,
  privateFileAccess: PrivateFileAccess,
): Promise<void> => {
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
  await privateFileAccess.verify(path);
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

export const mutateEntry = async (
  root: string,
  entry: Entry,
  privateFileAccess: PrivateFileAccess,
): Promise<void> => {
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
    await verifyPrivateFile(stage.path, entry.after.digest, privateFileAccess);
    await verifyState(root, entry, entry.before);
    await verifyBackup(root, entry, privateFileAccess);
    await rename(stage.path, path);
    const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await handle.chmod(entry.after.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await verifyBackup(root, entry, privateFileAccess);
    await unlink(path);
  }
  await syncDirectory(dirname(path));
  await verifyState(root, entry, entry.after);
};
