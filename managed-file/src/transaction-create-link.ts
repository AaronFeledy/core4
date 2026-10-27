import { constants } from "node:fs";
import { type FileHandle, link, open, unlink } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { errnoCode, isErrnoCode } from "@lando/sdk/errors";
import { syncDirectory } from "@lando/state-store/atomic";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import {
  openPinnedDirectory,
  pinnedChildPath,
  resolveJournalPath,
  syncPinnedDirectory,
} from "./transaction-create-path.ts";
import {
  type Phase,
  STAGE_MODE,
  assertPendingStage,
  isStage,
  modesMatch,
  readInode,
  requireCreate,
} from "./transaction-create.ts";
import {
  HARDLINK_PUBLICATION_REMEDIATION,
  type ManagedFileTransactionError,
  transactionError,
} from "./transaction-error.ts";
import { mutateEntry } from "./transaction-fs.ts";
import type { Entry, Stage } from "./transaction-journal.ts";
import { statMaybe } from "./transaction-private-file.ts";

const mapLinkError = (
  cause: unknown,
  phase: Phase,
  path: string,
): ManagedFileTransactionError | undefined => {
  if (isErrnoCode(cause, "EEXIST")) return transactionError("conflict", phase, path);
  const code = errnoCode(cause);
  if (
    code === "EXDEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS" ||
    code === "EPERM"
  ) {
    return transactionError("io", phase, path, HARDLINK_PUBLICATION_REMEDIATION);
  }
  return undefined;
};

const parentStill = async (
  path: string,
  inode: { readonly dev: string; readonly ino: string },
  phase: Phase,
  display: string,
) => {
  const stats = await statMaybe(path);
  if (
    stats === null ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    String(stats.dev) !== inode.dev ||
    String(stats.ino) !== inode.ino
  ) {
    throw transactionError("conflict", phase, display);
  }
};

const undoPinnedName = async (
  parent: FileHandle,
  parentPath: string,
  name: string,
  stage: Stage,
): Promise<void> => {
  const via = pinnedChildPath(parent.fd, name);
  if (via === undefined) return;
  const stats = await statMaybe(via);
  if (stats !== null && isStage(stats, stage)) {
    await unlink(via);
    await syncPinnedDirectory(parent, parentPath);
  }
};

const chmodLinked = async (
  parent: FileHandle,
  name: string,
  fallback: string,
  stage: Stage,
  mode: number,
  phase: Phase,
  display: string,
): Promise<void> => {
  const handle = await open(
    pinnedChildPath(parent.fd, name) ?? fallback,
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (String(opened.dev) !== stage.dev || String(opened.ino) !== stage.ino || opened.nlink !== 2) {
      throw transactionError("conflict", phase, display);
    }
    await handle.chmod(mode);
    const after = await handle.stat();
    if (String(after.dev) !== stage.dev || String(after.ino) !== stage.ino || after.nlink !== 2) {
      throw transactionError("conflict", phase, display);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const unlinkOwnedStage = async (entry: Entry, stage: Stage, target: string, phase: Phase): Promise<void> => {
  const stageStats = await statMaybe(stage.path);
  const targetStats = await statMaybe(target);
  if (
    stageStats === null ||
    targetStats === null ||
    !isStage(stageStats, stage) ||
    !isStage(targetStats, stage) ||
    stageStats.nlink !== 2 ||
    targetStats.nlink !== 2
  ) {
    throw transactionError("conflict", phase, entry.path);
  }
  await unlink(stage.path);
};

export interface PublishCreateInput {
  readonly root: string;
  readonly entry: Entry;
  readonly privateFileAccess: PrivateFileAccess;
  readonly phase: "commit" | "recover";
  readonly beforeLink?: () => Promise<void>;
  readonly afterLink?: () => Promise<void>;
}

/** Links an owner-only stage onto an absent path. Rename and byte-copy are not fallbacks. */
export const publishCreate = async (input: PublishCreateInput): Promise<void> => {
  const { entry, phase } = input;
  const { stage, mode } = requireCreate(entry, phase);
  await resolveJournalPath(input.root, relative(input.root, stage.path), phase);
  const target = await resolveJournalPath(input.root, entry.path, phase);
  await assertPendingStage(entry, stage, phase, input.privateFileAccess);
  const parentPath = dirname(target);
  const name = basename(target);
  const parent = await openPinnedDirectory(parentPath, phase, entry.path);
  const pinned = await parent.stat();
  const parentInode = { dev: String(pinned.dev), ino: String(pinned.ino) };
  try {
    if ((await statMaybe(target)) !== null) throw transactionError("conflict", phase, entry.path);
    await input.beforeLink?.();
    await resolveJournalPath(input.root, relative(input.root, stage.path), phase);
    await resolveJournalPath(input.root, entry.path, phase);
    await parentStill(parentPath, parentInode, phase, entry.path);
    try {
      await link(stage.path, pinnedChildPath(parent.fd, name) ?? target);
    } catch (cause) {
      const mapped = mapLinkError(cause, phase, entry.path);
      if (mapped !== undefined) throw mapped;
      throw cause;
    }
    try {
      await resolveJournalPath(input.root, relative(input.root, stage.path), phase);
      await resolveJournalPath(input.root, entry.path, phase);
      await parentStill(parentPath, parentInode, phase, entry.path);
    } catch (cause) {
      await undoPinnedName(parent, parentPath, name, stage);
      throw cause;
    }
    await chmodLinked(parent, name, target, stage, mode, phase, entry.path);
    await syncPinnedDirectory(parent, parentPath);
    await input.afterLink?.();
    try {
      await resolveJournalPath(input.root, relative(input.root, stage.path), phase);
      await resolveJournalPath(input.root, entry.path, phase);
      await parentStill(parentPath, parentInode, phase, entry.path);
    } catch (cause) {
      await undoPinnedName(parent, parentPath, name, stage);
      throw cause;
    }
  } finally {
    await parent.close();
  }
  await unlinkOwnedStage(entry, stage, target, phase);
  await syncDirectory(dirname(stage.path));
  await syncDirectory(parentPath);
};

/** Finishes the recorded stage/target pair after a crash between link and stage unlink. */
export const finishLinkedCreate = async (root: string, entry: Entry): Promise<void> => {
  const { stage, mode, digest } = requireCreate(entry, "recover");
  await resolveJournalPath(root, relative(root, stage.path), "recover");
  const target = await resolveJournalPath(root, entry.path, "recover");
  const read = await readInode(target, "recover", entry.path);
  if (read.dev !== stage.dev || read.ino !== stage.ino || read.nlink !== 2 || read.digest !== digest) {
    throw transactionError("conflict", "recover", entry.path);
  }
  if (!modesMatch(read.mode, STAGE_MODE) && !modesMatch(read.mode, mode)) {
    throw transactionError("conflict", "recover", entry.path);
  }
  const parentPath = dirname(target);
  const parent = await openPinnedDirectory(parentPath, "recover", entry.path);
  try {
    const pinned = await parent.stat();
    await resolveJournalPath(root, entry.path, "recover");
    await parentStill(
      parentPath,
      { dev: String(pinned.dev), ino: String(pinned.ino) },
      "recover",
      entry.path,
    );
    if (!modesMatch(read.mode, mode))
      await chmodLinked(parent, basename(target), target, stage, mode, "recover", entry.path);
    await syncPinnedDirectory(parent, parentPath);
  } finally {
    await parent.close();
  }
  await resolveJournalPath(root, relative(root, stage.path), "recover");
  await resolveJournalPath(root, entry.path, "recover");
  await unlinkOwnedStage(entry, stage, target, "recover");
  await syncDirectory(dirname(stage.path));
};

export const applyCommittedEntry = (input: {
  readonly root: string;
  readonly entry: Entry;
  readonly access: PrivateFileAccess;
  readonly beforeLink: () => Promise<void>;
  readonly afterLink: () => Promise<void>;
}): Promise<void> =>
  input.entry.publication === "create"
    ? publishCreate({
        root: input.root,
        entry: input.entry,
        privateFileAccess: input.access,
        phase: "commit",
        beforeLink: input.beforeLink,
        afterLink: input.afterLink,
      })
    : mutateEntry(input.root, input.entry, input.access);
