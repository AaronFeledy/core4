import { readdir, readlink } from "node:fs/promises";

const TCP_LISTEN = "0A";
// /proc/net/tcp{,6} stores each 32-bit word little-endian.
const IPV4_LOOPBACK = "0100007F";
const IPV6_LOOPBACK = "00000000000000000000000001000000";
const IPV6_V4MAPPED_LOOPBACK = "0000000000000000FFFF00000100007F";

/** Stay inside probeBudgetMs (min(5000, section/3) ≈ 3.3s) even with two leftover ports. */
export const COMM_SCAN_BUDGET_MS = 800;

export interface ProcWalk {
  readonly names: (path: string) => Promise<ReadonlyArray<string> | undefined>;
  readonly text: (path: string) => Promise<string | undefined>;
  readonly link: (path: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

const optionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const optionalNames = async (path: string): Promise<ReadonlyArray<string> | undefined> => {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const optionalLink = async (path: string): Promise<string | undefined> => {
  try {
    return await readlink(path);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const systemWalk: ProcWalk = {
  names: optionalNames,
  text: optionalText,
  link: optionalLink,
};

export const commLooksLikeRootlessport = (comm: string): boolean => /rootlessport|rootlessp\b/iu.test(comm);

export const isLoopbackLocalHex = (hex: string): boolean => {
  const normalized = hex.toUpperCase();
  return (
    normalized === IPV4_LOOPBACK || normalized === IPV6_LOOPBACK || normalized === IPV6_V4MAPPED_LOOPBACK
  );
};

export const parseListenInodeForLoopbackPort = (table: string, port: number): string | undefined => {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of table.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const local = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (local === undefined || state !== TCP_LISTEN || inode === undefined || inode === "0") continue;
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const address = local.slice(0, colon);
    const localPort = local.slice(colon + 1).toUpperCase();
    if (localPort !== expectedPort || !isLoopbackLocalHex(address)) continue;
    return inode;
  }
  return undefined;
};

const pastDeadline = (walk: ProcWalk, deadline: number): boolean => (walk.now ?? Date.now)() >= deadline;

/**
 * Identify the leftover-shaped holder of a listen inode.
 *
 * Doctor leftover only needs to know whether a rootlessport-shaped process owns
 * the socket. Reading each process comm first and walking fds only for those
 * candidates stays inside the plugin probe budget; a full process-fd walk does
 * not.
 */
export const commForSocketInode = async (
  inode: string,
  walk: ProcWalk = systemWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<string | undefined> => {
  const deadline = (walk.now ?? Date.now)() + budgetMs;
  const pids = await walk.names("/proc");
  if (pids === undefined) return undefined;

  const candidates: Array<{ readonly pid: string; readonly comm: string }> = [];
  for (const pid of pids) {
    if (pastDeadline(walk, deadline)) return undefined;
    if (!/^\d+$/u.test(pid)) continue;
    const comm = await walk.text(`/proc/${pid}/comm`);
    if (comm === undefined) continue;
    const trimmed = comm.trim();
    if (commLooksLikeRootlessport(trimmed)) candidates.push({ pid, comm: trimmed });
  }

  for (const candidate of candidates) {
    if (pastDeadline(walk, deadline)) return undefined;
    const fds = await walk.names(`/proc/${candidate.pid}/fd`);
    if (fds === undefined) continue;
    for (const fd of fds) {
      if (pastDeadline(walk, deadline)) return undefined;
      const target = await walk.link(`/proc/${candidate.pid}/fd/${fd}`);
      if (target !== `socket:[${inode}]`) continue;
      return candidate.comm;
    }
  }
  return undefined;
};

export const identifyLoopbackHolderComm = async (
  port: number,
  walk: ProcWalk = systemWalk,
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
