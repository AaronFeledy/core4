import { readFileSync } from "node:fs";
import { isErrnoCode } from "@lando/sdk/errors";
import type { AdvisoryLockRecord } from "@lando/state-store/lock";

/**
 * A child `lando` process must never borrow its parent's app lock: the parent cannot finish until
 * the child does. The holder token in this variable, or the holder pid being an ancestor, marks
 * such a child so it refuses instead of waiting forever.
 */
export const APP_LOCK_HOLDERS_ENV = "LANDO_APP_LOCK_HOLDERS";

const parseHolderEntries = (raw: string | undefined): ReadonlyArray<readonly [string, string]> => {
  if (raw === undefined || raw === "") return [];
  return raw.split(",").flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0) return [];
    const key = entry.slice(0, separator);
    const token = entry.slice(separator + 1);
    return key === "" || token === "" ? [] : ([[key, token]] as const);
  });
};

const serializeHolderEntries = (entries: ReadonlyArray<readonly [string, string]>): string =>
  entries.map(([key, token]) => `${key}:${token}`).join(",");

export const installHolderEnv = (key: string, token: string): (() => void) => {
  const previous = process.env[APP_LOCK_HOLDERS_ENV];
  const next = serializeHolderEntries([
    ...parseHolderEntries(previous).filter(([held]) => held !== key),
    [key, token],
  ]);
  process.env[APP_LOCK_HOLDERS_ENV] = next;
  return () => {
    if (previous === undefined) delete process.env[APP_LOCK_HOLDERS_ENV];
    else process.env[APP_LOCK_HOLDERS_ENV] = previous;
  };
};

const parentPidOf = (pid: number): number | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
};

export const isSelfOrAncestorPid = (holderPid: number, pid = process.pid, ppid = process.ppid): boolean => {
  if (holderPid === pid) return true;
  let current = ppid;
  const seen = new Set<number>([pid]);
  while (current > 1 && !seen.has(current)) {
    if (current === holderPid) return true;
    seen.add(current);
    const parent = parentPidOf(current);
    if (parent === undefined) break;
    current = parent;
  }
  return false;
};

/** Child of the lock holder, not another fiber in the same process. */
export const isAncestorPid = (holderPid: number, pid = process.pid, ppid = process.ppid): boolean =>
  holderPid !== pid && isSelfOrAncestorPid(holderPid, pid, ppid);

/**
 * True when a contended lock's diagnostic record names a live ancestor or an
 * inherited holder token for this key. Same-process fiber contention and dead
 * holders must wait (or acquire), never refuse as nested borrow.
 */
export const isBorrowedOwner = (key: string, record: AdvisoryLockRecord): boolean => {
  if (record.pid === process.pid) return false;
  try {
    process.kill(record.pid, 0);
  } catch (cause) {
    if (isErrnoCode(cause, "ESRCH")) return false;
  }
  return (
    isAncestorPid(record.pid) ||
    parseHolderEntries(process.env[APP_LOCK_HOLDERS_ENV]).some(
      ([held, token]) => held === key && token === record.token,
    )
  );
};
