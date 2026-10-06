import { readdir, readlink } from "node:fs/promises";

export const TCP_LISTEN = "0A";
/** Stay inside probeBudgetMs (min(5000, section/3) ≈ 3.3s) even with two leftover ports. */
export const COMM_SCAN_BUDGET_MS = 800;

const IPV4_LOOPBACK = "0100007F";
const IPV6_LOOPBACK = "00000000000000000000000001000000";
const IPV6_V4MAPPED_LOOPBACK = "0000000000000000FFFF00000100007F";

const isLoopbackLocalHex = (hex: string): boolean => {
  const normalized = hex.toUpperCase();
  return (
    normalized === IPV4_LOOPBACK || normalized === IPV6_LOOPBACK || normalized === IPV6_V4MAPPED_LOOPBACK
  );
};

export const parseListenInodeForPort = (
  table: string,
  port: number,
  loopbackOnly = false,
): string | undefined => {
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
    if (localPort !== expectedPort || (loopbackOnly && !isLoopbackLocalHex(address))) continue;
    return inode;
  }
  return undefined;
};

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

export const systemProcWalk: ProcWalk = {
  names: optionalNames,
  text: optionalText,
  link: optionalLink,
};

export const pastDeadline = (walk: ProcWalk, deadline: number): boolean =>
  (walk.now ?? Date.now)() >= deadline;
