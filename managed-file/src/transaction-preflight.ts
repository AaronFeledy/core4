import { lstat } from "node:fs/promises";
import { relative } from "node:path";
import { transactionError } from "./transaction-error.ts";
import { sameState, snapshot, statMaybe, targetPath, verifyBackup } from "./transaction-fs.ts";
import type { Entry, Journal } from "./transaction-journal.ts";

/**
 * What an incomplete journal entry still needs. `pending` has not been renamed
 * yet, `applied` is fully published, and `applied-needs-mode` landed its rename
 * but crashed before the intended output mode replaced the stage's owner-only
 * mode.
 */
export type Disposition = "pending" | "applied" | "applied-needs-mode";

export interface Classified {
  readonly entry: Entry;
  readonly disposition: Disposition;
}

const STAGE_MODE = 0o600;

const ownedFile = (stats: { mode: number; uid: number }): boolean =>
  process.platform === "win32" || ((stats.mode & 0o077) === 0 && stats.uid === process.getuid?.());

/** Rejects a persisted plan that could never have been produced by planning. */
const validatePlan = (journal: Journal): void => {
  const paths = new Set<string>();
  for (const entry of journal.entries) {
    if (paths.has(entry.path)) throw transactionError("journal", "recover", entry.path);
    paths.add(entry.path);
    if (sameState(entry.before, entry.after)) throw transactionError("journal", "recover", entry.path);
    if (entry.after.present === (entry.stage === undefined))
      throw transactionError("journal", "recover", entry.path);
  }
};

const stagePath = async (root: string, entry: Entry): Promise<string> => {
  const stage = entry.stage;
  if (stage === undefined) throw transactionError("journal", "recover", entry.path);
  return await targetPath(root, relative(root, stage.path));
};

/** An applied write must still be the renamed stage inode with no stage left behind. */
const requireApplied = async (root: string, entry: Entry): Promise<void> => {
  if (!entry.after.present) return;
  const stage = entry.stage;
  if (stage === undefined) throw transactionError("journal", "recover", entry.path);
  const path = await stagePath(root, entry);
  if ((await statMaybe(path)) !== null) throw transactionError("conflict", "recover", entry.path);
  const target = await lstat(await targetPath(root, entry.path));
  if (String(target.dev) !== stage.dev || String(target.ino) !== stage.ino)
    throw transactionError("conflict", "recover", entry.path);
};

/** A pending write must still hold its exclusive owner-only stage byte for byte. */
const requirePending = async (root: string, entry: Entry): Promise<void> => {
  if (!entry.after.present) return;
  const stage = entry.stage;
  if (stage === undefined) throw transactionError("journal", "recover", entry.path);
  const path = await stagePath(root, entry);
  const stats = await statMaybe(path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    !ownedFile(stats) ||
    (process.platform !== "win32" && (stats.mode & 0o7777) !== STAGE_MODE) ||
    String(stats.dev) !== stage.dev ||
    String(stats.ino) !== stage.ino
  ) {
    throw transactionError("conflict", "recover", entry.path);
  }
  const read = await snapshot(path);
  if (!read.state.present || read.state.digest !== entry.after.digest)
    throw transactionError("conflict", "recover", entry.path);
};

const classifyEntry = async (root: string, entry: Entry): Promise<Disposition> => {
  const path = await targetPath(root, entry.path);
  const current = (await snapshot(path)).state;
  await verifyBackup(root, entry);
  if (sameState(current, entry.after)) {
    await requireApplied(root, entry);
    return "applied";
  }
  if (sameState(current, entry.before)) {
    await requirePending(root, entry);
    return "pending";
  }
  const stage = entry.stage;
  if (
    entry.after.present &&
    stage !== undefined &&
    current.present &&
    current.digest === entry.after.digest &&
    current.mode !== entry.after.mode &&
    (process.platform === "win32" || (entry.after.mode !== STAGE_MODE && current.mode === STAGE_MODE)) &&
    (await statMaybe(await stagePath(root, entry))) === null
  ) {
    const target = await lstat(path);
    if (String(target.dev) === stage.dev && String(target.ino) === stage.ino) return "applied-needs-mode";
  }
  throw transactionError("conflict", "recover", entry.path);
};

/**
 * Classifies every entry of an incomplete journal against the complete recorded
 * before/after plan before any target is touched. Any lock, path, absence,
 * symlink, hash, mode, backup, or stage mismatch throws instead of guessing.
 */
export const preflight = async (root: string, journal: Journal): Promise<readonly Classified[]> => {
  validatePlan(journal);
  const classified: Classified[] = [];
  for (const entry of journal.entries)
    classified.push({ entry, disposition: await classifyEntry(root, entry) });
  return classified;
};
