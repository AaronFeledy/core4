import { resolve as resolvePath } from "node:path";
import { isPathWithin } from "@lando/paths";

import {
  COMM_SCAN_BUDGET_MS,
  type ProcWalk,
  parseListenInodeForPort,
  pastDeadline,
  systemProcWalk,
} from "./proc-walk.ts";

export type { ProcWalk } from "./proc-walk.ts";

const DELETED_EXE_SUFFIX = " (deleted)";

type LoopbackHolder = {
  readonly comm: string;
  readonly pid: number;
  readonly exe?: string;
};

type RootlessportOrigin = "this-runtime" | "other-data-root" | "unknown";

export const commLooksLikeRootlessport = (comm: string): boolean => /rootlessport|rootlessp\b/iu.test(comm);

export const parseListenInodeForLoopbackPort = (table: string, port: number): string | undefined =>
  parseListenInodeForPort(table, port, true);

export const normalizeProcExe = (raw: string): string => {
  const stripped = raw.endsWith(DELETED_EXE_SUFFIX) ? raw.slice(0, -DELETED_EXE_SUFFIX.length) : raw;
  return stripped.trim();
};

const normalizeLexical = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/u, "");

export const runtimeBinDirOfExe = (exe: string): string | undefined => {
  const normalized = normalizeLexical(normalizeProcExe(exe));
  if (normalized.length === 0) return undefined;
  const marker = "/runtime/bin/";
  const indexed = normalized.lastIndexOf(marker);
  if (indexed >= 0) return normalized.slice(0, indexed + "/runtime/bin".length);
  return undefined;
};

const underDir = (dir: string, candidate: string): boolean => {
  const root = normalizeLexical(resolvePath(dir));
  const path = normalizeLexical(resolvePath(candidate));
  return isPathWithin(root, path);
};

export const classifyRootlessportOrigin = (
  exe: string | undefined,
  thisRuntimeBinDir: string | undefined,
): RootlessportOrigin => {
  if (exe === undefined) return "unknown";
  const normalizedExe = normalizeProcExe(exe);
  if (normalizedExe.length === 0) return "unknown";

  if (thisRuntimeBinDir !== undefined && thisRuntimeBinDir.length > 0) {
    if (underDir(thisRuntimeBinDir, normalizedExe)) return "this-runtime";
  }

  const ownerBin = runtimeBinDirOfExe(normalizedExe);
  if (ownerBin === undefined) return "unknown";

  return "other-data-root";
};

/**
 * Doctor leftover only needs to know whether a rootlessport-shaped process owns
 * the socket. Reading each process comm first and walking fds only for those
 * candidates stays inside the plugin probe budget; a full process-fd walk does
 * not. When a holder is found, also capture /proc/<pid>/exe so a live forwarder
 * from another data root is never labeled leftover.
 */
export const holderForSocketInode = async (
  inode: string,
  walk: ProcWalk = systemProcWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<LoopbackHolder | undefined> => {
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
      if (target !== `socket:[${inode}]`) continue;
      const exeRaw = await walk.link(`/proc/${pid}/exe`);
      const holder: LoopbackHolder = { comm: trimmed, pid: Number(pid) };
      if (exeRaw === undefined || exeRaw.length === 0) return holder;
      return { ...holder, exe: normalizeProcExe(exeRaw) };
    }
  }
  return undefined;
};

export const commForSocketInode = async (
  inode: string,
  walk: ProcWalk = systemProcWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<string | undefined> => {
  const holder = await holderForSocketInode(inode, walk, budgetMs);
  return holder?.comm;
};

export const identifyLoopbackHolder = async (
  port: number,
  walk: ProcWalk = systemProcWalk,
  budgetMs: number = COMM_SCAN_BUDGET_MS,
): Promise<LoopbackHolder | undefined> => {
  const tables = await Promise.all([walk.text("/proc/net/tcp"), walk.text("/proc/net/tcp6")]);
  for (const table of tables) {
    if (table === undefined) continue;
    const inode = parseListenInodeForLoopbackPort(table, port);
    if (inode === undefined) continue;
    const holder = await holderForSocketInode(inode, walk, budgetMs);
    if (holder !== undefined) return holder;
  }
  return undefined;
};
