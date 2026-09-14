import { readdir, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HOST_PROXY_WORKER_ARGV,
  type PerformanceProcess,
  readPerformanceProcess,
} from "./workflow-performance-processes.ts";

const TCP_LISTEN = "0A";

export type IsolationPhase = "before-prepare" | "after-prepare" | "after-cleanup";

export type PerformanceIsolationRoots = {
  readonly sampleRoot: string;
  readonly dataRoot: string;
  readonly runtimeRoot: string;
};

export type ListenEntry = {
  readonly port: number;
  readonly inode: string;
};

export type OwnedListen = {
  readonly port: number;
  readonly pid: number;
  readonly comm: string;
};

export type OwnedResourceSnapshot = {
  readonly processes: readonly PerformanceProcess[];
  readonly listen: readonly OwnedListen[];
  readonly sockets: readonly string[];
  readonly nftHints: readonly string[];
  readonly stray: readonly PerformanceProcess[];
};

export type IsolationWalk = {
  readonly uid: number;
  readonly roots: readonly string[];
  readonly pids: () => Promise<readonly number[]>;
  readonly process: (pid: number) => Promise<PerformanceProcess | undefined>;
  readonly fds: (pid: number) => Promise<readonly string[]>;
  readonly fdTarget: (pid: number, fd: string) => Promise<string | undefined>;
  readonly tcpTables: () => Promise<readonly string[]>;
  readonly netnsTcpTables: (pid: number) => Promise<readonly string[]>;
  readonly socketNames: () => Promise<readonly string[]>;
  readonly nftHints?: (pids: readonly number[]) => Promise<readonly string[]>;
  readonly stray?: () => Promise<readonly PerformanceProcess[]>;
};

export const processTouchesPerformanceRoot = (snapshot: PerformanceProcess, root: string): boolean =>
  snapshot.executable === root ||
  snapshot.executable.startsWith(`${root}/`) ||
  snapshot.argv.some((arg) => arg === root || arg.startsWith(`${root}/`));

export const parseListenEntries = (table: string): readonly ListenEntry[] => {
  const entries: ListenEntry[] = [];
  for (const line of table.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const local = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (local === undefined || state !== TCP_LISTEN || inode === undefined || inode === "0") continue;
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number.parseInt(local.slice(colon + 1), 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    entries.push({ port, inode });
  }
  return entries;
};

const optionalNames = async (path: string): Promise<readonly string[]> => {
  try {
    return await readdir(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
};

const optionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await Bun.file(path).text();
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

const optionalLink = async (path: string): Promise<string | undefined> => {
  try {
    return await readlink(path);
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

const processLabel = (snapshot: PerformanceProcess): string =>
  `${snapshot.pid}:${snapshot.executable.split("/").at(-1) ?? snapshot.executable}`;

export const liveIsolationWalk = (roots: PerformanceIsolationRoots): IsolationWalk => {
  const uid = process.getuid?.() ?? -1;
  const ownedRoots = [roots.sampleRoot, roots.dataRoot, roots.runtimeRoot];
  const pids = async () =>
    (await optionalNames("/proc")).filter((entry) => /^\d+$/u.test(entry)).map((entry) => Number(entry));
  return {
    uid,
    roots: ownedRoots,
    pids,
    process: readPerformanceProcess,
    fds: (pid) => optionalNames(`/proc/${pid}/fd`),
    fdTarget: (pid, fd) => optionalLink(`/proc/${pid}/fd/${fd}`),
    tcpTables: async () =>
      (await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(optionalText))).filter(
        (table): table is string => table !== undefined,
      ),
    netnsTcpTables: async (pid) =>
      (await Promise.all([`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`].map(optionalText))).filter(
        (table): table is string => table !== undefined,
      ),
    socketNames: async () => [
      ...(await optionalNames(roots.runtimeRoot)),
      ...(await optionalNames(join(roots.dataRoot, "runtime/run"))),
    ],
    nftHints: async (owned) => {
      const hints: string[] = [];
      for (const pid of owned) {
        try {
          await stat(`/proc/${pid}/net/nf_tables`);
          hints.push(`${pid}:nf_tables`);
        } catch (cause) {
          if (
            !(
              cause instanceof Error &&
              "code" in cause &&
              (cause.code === "ENOENT" || cause.code === "EACCES")
            )
          )
            throw cause;
        }
      }
      return hints;
    },
    stray: async () => {
      const found: PerformanceProcess[] = [];
      for (const pid of await pids()) {
        const snapshot = await readPerformanceProcess(pid);
        if (snapshot === undefined || snapshot.uid !== uid) continue;
        if (!snapshot.argv.includes(HOST_PROXY_WORKER_ARGV)) continue;
        if (ownedRoots.some((root) => processTouchesPerformanceRoot(snapshot, root))) continue;
        found.push(snapshot);
      }
      return found;
    },
  };
};

export const inspectOwnedPerformanceResources = async (
  walk: IsolationWalk,
): Promise<OwnedResourceSnapshot> => {
  const processes: PerformanceProcess[] = [];
  for (const pid of await walk.pids()) {
    const snapshot = await walk.process(pid);
    if (snapshot === undefined || snapshot.uid !== walk.uid) continue;
    if (!walk.roots.some((root) => processTouchesPerformanceRoot(snapshot, root))) continue;
    processes.push(snapshot);
  }
  const inodeOwners = new Map<string, PerformanceProcess>();
  for (const snapshot of processes) {
    for (const fd of await walk.fds(snapshot.pid)) {
      const target = await walk.fdTarget(snapshot.pid, fd);
      const match = target?.match(/^socket:\[(\d+)\]$/u);
      const inode = match?.[1];
      if (inode !== undefined) inodeOwners.set(inode, snapshot);
    }
  }
  const tables = [
    ...(await walk.tcpTables()),
    ...(await Promise.all(processes.map((snapshot) => walk.netnsTcpTables(snapshot.pid)))).flat(),
  ];
  const listen: OwnedListen[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    for (const entry of parseListenEntries(table)) {
      const owner = inodeOwners.get(entry.inode);
      const key = `${entry.port}:${entry.inode}`;
      if (owner === undefined || seen.has(key)) continue;
      seen.add(key);
      listen.push({ port: entry.port, pid: owner.pid, comm: owner.executable });
    }
  }
  return {
    processes,
    listen,
    sockets: await walk.socketNames(),
    nftHints: (await walk.nftHints?.(processes.map((snapshot) => snapshot.pid))) ?? [],
    stray: (await walk.stray?.()) ?? [],
  };
};

export const recordPerformanceIsolation = async (
  phase: IsolationPhase,
  roots: PerformanceIsolationRoots,
): Promise<OwnedResourceSnapshot> => {
  if (process.env.WORKFLOW_PERF_ISOLATION !== "1")
    return { processes: [], listen: [], sockets: [], nftHints: [], stray: [] };
  const snapshot = await inspectOwnedPerformanceResources(liveIsolationWalk(roots));
  try {
    await writeFile(join(roots.sampleRoot, `isolation-${phase}.json`), `${JSON.stringify(snapshot)}\n`);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    if (process.env.WORKFLOW_PERF_ISOLATION === "1")
      process.stderr.write(`perf-isolation ${phase} write-failed ${cause.message}\n`);
  }
  if (process.env.WORKFLOW_PERF_ISOLATION === "1")
    process.stderr.write(
      `perf-isolation ${phase} processes=${snapshot.processes.map(processLabel).join(",") || "none"} listen=${snapshot.listen.map((entry) => `${entry.port}@${entry.pid}`).join(",") || "none"} stray=${snapshot.stray.map(processLabel).join(",") || "none"} sockets=${snapshot.sockets.length} nft=${snapshot.nftHints.length}\n`,
    );
  return snapshot;
};
