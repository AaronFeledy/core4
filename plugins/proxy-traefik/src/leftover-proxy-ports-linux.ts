import { readdir, readlink } from "node:fs/promises";

const TCP_LISTEN = "0A";
// /proc/net/tcp{,6} stores each 32-bit word little-endian.
const IPV4_LOOPBACK = "0100007F";
const IPV6_LOOPBACK = "00000000000000000000000001000000";
const IPV6_V4MAPPED_LOOPBACK = "0000000000000000FFFF00000100007F";

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

const commForSocketInode = async (inode: string): Promise<string | undefined> => {
  const pids = await optionalNames("/proc");
  if (pids === undefined) return undefined;
  for (const pid of pids) {
    if (!/^\d+$/u.test(pid)) continue;
    const fds = await optionalNames(`/proc/${pid}/fd`);
    if (fds === undefined) continue;
    for (const fd of fds) {
      const target = await optionalLink(`/proc/${pid}/fd/${fd}`);
      if (target !== `socket:[${inode}]`) continue;
      const comm = await optionalText(`/proc/${pid}/comm`);
      if (comm === undefined) return undefined;
      return comm.trim();
    }
  }
  return undefined;
};

export const identifyLoopbackHolderComm = async (port: number): Promise<string | undefined> => {
  const tables = await Promise.all([optionalText("/proc/net/tcp"), optionalText("/proc/net/tcp6")]);
  for (const table of tables) {
    if (table === undefined) continue;
    const inode = parseListenInodeForLoopbackPort(table, port);
    if (inode === undefined) continue;
    const comm = await commForSocketInode(inode);
    if (comm !== undefined) return comm;
  }
  return undefined;
};
