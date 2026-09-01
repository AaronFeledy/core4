import { readdir, readlink } from "node:fs/promises";

import type { ProcWalk } from "./leftover-proxy-ports-linux.ts";

import { systemdServiceFromCgroup } from "./occupied-port-warning.ts";

const TCP_LISTEN = "0A";
const COMM_SCAN_BUDGET_MS = 800;

export type PortHolder = {
  readonly comm: string;
  readonly pid: number;
  readonly cmdline?: string;
};

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

const pastDeadline = (walk: ProcWalk, deadline: number): boolean => (walk.now ?? Date.now)() >= deadline;

export const parseListenInodeForPort = (table: string, port: number): string | undefined => {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of table.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const local = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (local === undefined || state !== TCP_LISTEN || inode === undefined || inode === "0") continue;
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const localPort = local.slice(colon + 1).toUpperCase();
    if (localPort !== expectedPort) continue;
    return inode;
  }
  return undefined;
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
  walk: ProcWalk = systemWalk,
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
  walk: ProcWalk = systemWalk,
): Promise<string | undefined> => {
  const cgroup = await walk.text(`/proc/${pid}/cgroup`);
  if (cgroup === undefined) return undefined;
  return systemdServiceFromCgroup(cgroup);
};
