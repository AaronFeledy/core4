import {
  COMM_SCAN_BUDGET_MS,
  type ProcWalk,
  parseListenInodeForPort,
  pastDeadline,
  systemProcWalk,
} from "./proc-walk.ts";

export type { ProcWalk } from "./proc-walk.ts";

export const commLooksLikeRootlessport = (comm: string): boolean => /rootlessport|rootlessp\b/iu.test(comm);

export const parseListenInodeForLoopbackPort = (table: string, port: number): string | undefined =>
  parseListenInodeForPort(table, port, true);

/**
 * Doctor leftover only needs to know whether a rootlessport-shaped process owns
 * the socket. Reading each process comm first and walking fds only for those
 * candidates stays inside the plugin probe budget; a full process-fd walk does
 * not.
 */
export const commForSocketInode = async (
  inode: string,
  walk: ProcWalk = systemProcWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<string | undefined> => {
  const deadline = (walk.now ?? Date.now)() + budgetMs;
  const pids = await walk.names("/proc");
  if (pids === undefined) return undefined;

  for (const pid of pids) {
    if (pastDeadline(walk, deadline)) return undefined;
    if (!/^\d+$/u.test(pid)) continue;
    const comm = await walk.text(`/proc/${pid}/comm`);
    if (comm === undefined) continue;
    const trimmed = comm.trim();
    if (!commLooksLikeRootlessport(trimmed)) continue;
    const fds = await walk.names(`/proc/${pid}/fd`);
    if (fds === undefined) continue;
    for (const fd of fds) {
      if (pastDeadline(walk, deadline)) return undefined;
      const target = await walk.link(`/proc/${pid}/fd/${fd}`);
      if (target === `socket:[${inode}]`) return trimmed;
    }
  }
  return undefined;
};

export const identifyLoopbackHolderComm = async (
  port: number,
  walk: ProcWalk = systemProcWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<string | undefined> => {
  const tables = await Promise.all([walk.text("/proc/net/tcp"), walk.text("/proc/net/tcp6")]);
  for (const table of tables) {
    if (table === undefined) continue;
    const inode = parseListenInodeForLoopbackPort(table, port);
    if (inode === undefined) continue;
    const comm = await commForSocketInode(inode, walk, budgetMs);
    if (comm !== undefined) return comm;
  }
  return undefined;
};
