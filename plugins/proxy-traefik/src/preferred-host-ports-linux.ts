import { systemdServiceFromCgroup } from "./occupied-port-warning.ts";
import {
  COMM_SCAN_BUDGET_MS,
  type ProcWalk,
  parseListenInodeForPort,
  pastDeadline,
  systemProcWalk,
} from "./proc-walk.ts";

export { parseListenInodeForPort } from "./proc-walk.ts";

export type PortHolder = {
  readonly comm: string;
  readonly pid: number;
  readonly cmdline?: string;
};

const cmdlineFrom = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.length === 0) return undefined;
  const cmdline = raw.replaceAll("\0", " ");
  return cmdline.length === 0 ? undefined : cmdline;
};

const holderForSocketInode = async (
  inode: string,
  walk: ProcWalk,
  budgetMs: number,
): Promise<PortHolder | undefined> => {
  const deadline = (walk.now ?? Date.now)() + budgetMs;
  const pids = await walk.names("/proc");
  if (pids === undefined) return undefined;

  for (const pid of pids) {
    if (pastDeadline(walk, deadline)) return undefined;
    if (!/^\d+$/u.test(pid)) continue;
    const fds = await walk.names(`/proc/${pid}/fd`);
    if (fds === undefined) continue;
    for (const fd of fds) {
      if (pastDeadline(walk, deadline)) return undefined;
      const target = await walk.link(`/proc/${pid}/fd/${fd}`);
      if (target !== `socket:[${inode}]`) continue;
      const comm = await walk.text(`/proc/${pid}/comm`);
      if (comm === undefined) continue;
      const holder: PortHolder = { comm: comm.trim(), pid: Number(pid) };
      const cmdline = cmdlineFrom(await walk.text(`/proc/${pid}/cmdline`));
      return cmdline === undefined ? holder : { ...holder, cmdline };
    }
  }
  return undefined;
};

export const identifyAnyPortHolder = async (
  port: number,
  walk: ProcWalk = systemProcWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<PortHolder | undefined> => {
  const tables = await Promise.all([walk.text("/proc/net/tcp"), walk.text("/proc/net/tcp6")]);
  for (const table of tables) {
    if (table === undefined) continue;
    const inode = parseListenInodeForPort(table, port);
    if (inode === undefined) continue;
    const holder = await holderForSocketInode(inode, walk, budgetMs);
    if (holder !== undefined) return holder;
  }
  return undefined;
};

export const systemdUnitForPid = async (
  pid: number,
  walk: ProcWalk = systemProcWalk,
): Promise<string | undefined> => {
  const cgroup = await walk.text(`/proc/${pid}/cgroup`);
  if (cgroup === undefined) return undefined;
  return systemdServiceFromCgroup(cgroup);
};
