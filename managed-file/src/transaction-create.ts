import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { relative } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { isErrnoCode } from "@lando/sdk/errors";
import { type PrivateFileAccess, PrivateFileAccessError } from "@lando/state-store/private-file-access";
import { resolveJournalPath } from "./transaction-create-path.ts";
import { type ManagedFileTransactionError, transactionError } from "./transaction-error.ts";
import type { Entry, Stage } from "./transaction-journal.ts";
import { statMaybe } from "./transaction-private-file.ts";

export type Phase = ManagedFileTransactionError["phase"];
export type CreateDisposition = "pending" | "applied" | "applied-needs-mode" | "linked";
export const STAGE_MODE = 0o600;

export const modesMatch = (left: number, right: number): boolean => {
  const mask = process.platform === "win32" ? 0o200 : 0o777;
  return (left & mask) === (right & mask);
};

const verifyPrivate = async (
  path: string,
  phase: Phase,
  display: string,
  access: PrivateFileAccess,
): Promise<void> => {
  try {
    await access.verify(path);
  } catch (cause) {
    if (cause instanceof PrivateFileAccessError) throw transactionError("conflict", phase, display);
    throw cause;
  }
};

interface InodeRead {
  readonly dev: string;
  readonly ino: string;
  readonly nlink: number;
  readonly mode: number;
  readonly digest: string;
}

export const readInode = async (path: string, phase: Phase, display: string): Promise<InodeRead> => {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (isErrnoCode(cause, "ELOOP") || isErrnoCode(cause, "ENOENT"))
      throw transactionError("conflict", phase, display);
    throw cause;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw transactionError("conflict", phase, display);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw transactionError("conflict", phase, display);
    }
    return {
      dev: String(opened.dev),
      ino: String(opened.ino),
      nlink: opened.nlink,
      mode: opened.mode & 0o7777,
      digest: sha256Hex(bytes),
    };
  } finally {
    await handle.close();
  }
};

export const isStage = (stats: NonNullable<Awaited<ReturnType<typeof statMaybe>>>, stage: Stage): boolean =>
  stats.isFile() &&
  !stats.isSymbolicLink() &&
  String(stats.dev) === stage.dev &&
  String(stats.ino) === stage.ino;

export const requireCreate = (
  entry: Entry,
  phase: Phase,
): { readonly stage: Stage; readonly mode: number; readonly digest: string } => {
  if (
    entry.publication !== "create" ||
    entry.before.present ||
    !entry.after.present ||
    entry.stage === undefined
  ) {
    throw transactionError("journal", phase, entry.path);
  }
  if (!Number.isInteger(entry.after.mode) || entry.after.mode < 0 || entry.after.mode > 0o777) {
    throw transactionError("journal", phase, entry.path);
  }
  return { stage: entry.stage, mode: entry.after.mode, digest: entry.after.digest };
};

export const assertPendingStage = async (
  entry: Entry,
  stage: Stage,
  phase: Phase,
  access: PrivateFileAccess,
): Promise<void> => {
  const stats = await statMaybe(stage.path);
  if (stats === null || !isStage(stats, stage) || stats.nlink !== 1)
    throw transactionError("conflict", phase, entry.path);
  if (
    process.platform !== "win32" &&
    (stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== STAGE_MODE)
  ) {
    throw transactionError("conflict", phase, entry.path);
  }
  await verifyPrivate(stage.path, phase, entry.path, access);
  const read = await readInode(stage.path, phase, entry.path);
  if (
    !entry.after.present ||
    read.dev !== stage.dev ||
    read.ino !== stage.ino ||
    read.nlink !== 1 ||
    read.digest !== entry.after.digest
  ) {
    throw transactionError("conflict", phase, entry.path);
  }
};

export const classifyCreate = async (
  root: string,
  entry: Entry,
  access: PrivateFileAccess,
): Promise<CreateDisposition> => {
  const { stage, mode, digest } = requireCreate(entry, "recover");
  await resolveJournalPath(root, relative(root, stage.path), "recover");
  const target = await resolveJournalPath(root, entry.path, "recover");
  const stageStats = await statMaybe(stage.path);
  const targetStats = await statMaybe(target);
  if (targetStats !== null && (!targetStats.isFile() || targetStats.isSymbolicLink())) {
    throw transactionError("conflict", "recover", entry.path);
  }
  const stageMatches = stageStats !== null && isStage(stageStats, stage);
  const targetMatches = targetStats !== null && isStage(targetStats, stage);
  if (targetMatches && stageMatches && stageStats !== null && targetStats !== null) {
    if (stageStats.nlink !== 2 || targetStats.nlink !== 2)
      throw transactionError("conflict", "recover", entry.path);
    const read = await readInode(target, "recover", entry.path);
    if (read.digest !== digest || read.nlink !== 2 || read.dev !== stage.dev || read.ino !== stage.ino) {
      throw transactionError("conflict", "recover", entry.path);
    }
    if (!modesMatch(read.mode, STAGE_MODE) && !modesMatch(read.mode, mode)) {
      throw transactionError("conflict", "recover", entry.path);
    }
    return "linked";
  }
  if (targetMatches && stageStats === null && targetStats !== null) {
    const read = await readInode(target, "recover", entry.path);
    if (read.digest !== digest || read.nlink !== 1 || read.dev !== stage.dev || read.ino !== stage.ino) {
      throw transactionError("conflict", "recover", entry.path);
    }
    if (modesMatch(read.mode, mode)) return "applied";
    if (modesMatch(read.mode, STAGE_MODE)) return "applied-needs-mode";
    throw transactionError("conflict", "recover", entry.path);
  }
  if (targetStats === null && stageMatches && stageStats !== null && stageStats.nlink === 1) {
    await assertPendingStage(entry, stage, "recover", access);
    return "pending";
  }
  throw transactionError("conflict", "recover", entry.path);
};

export const createdOutputs = (entries: readonly Entry[]) =>
  entries
    .flatMap((entry) =>
      entry.publication === "create" && entry.after.present
        ? [{ path: entry.path, digest: entry.after.digest, mode: entry.after.mode }]
        : [],
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
