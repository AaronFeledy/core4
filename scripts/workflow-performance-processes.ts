import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { PerformanceStoreCleanupError } from "./workflow-performance-stores.ts";

export type PerformanceProcess = {
  readonly pid: number;
  readonly uid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly argv: readonly string[];
};

export const readPerformanceProcess = async (pid: number): Promise<PerformanceProcess | undefined> => {
  try {
    const before = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTime = before.slice(before.lastIndexOf(")") + 2).split(" ")[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime))
      throw new PerformanceStoreCleanupError(`Invalid process identity: ${pid}`);
    const uid = (await stat(`/proc/${pid}`)).uid;
    const executable = await readlink(`/proc/${pid}/exe`);
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    const after = await readFile(`/proc/${pid}/stat`, "utf8");
    if (after.slice(after.lastIndexOf(")") + 2).split(" ")[19] !== startTime) return undefined;
    return { pid, uid, startTime, executable, argv };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
};

export const isPerformanceRuntimeHelper = (snapshot: PerformanceProcess, root: string): boolean =>
  (snapshot.executable === `${root}/runtime/bin/podman` && snapshot.argv.length === 1) ||
  (snapshot.executable === `${root}/runtime/bin/conmon` &&
    snapshot.argv.some((arg) => arg === "--exec" || arg === "-e") &&
    snapshot.argv[snapshot.argv.indexOf("-b") + 1]?.startsWith(
      `${root}/runtime/storage/overlay-containers/`,
    ) === true) ||
  (snapshot.executable === `${root}/runtime/bin/fuse-overlayfs` &&
    snapshot.argv.some((arg) => arg.includes(`${root}/runtime/storage/`)));

export const signalPerformanceProcess = async (
  snapshot: PerformanceProcess,
  read: (pid: number) => Promise<PerformanceProcess | undefined>,
  signal: (pid: number) => void,
): Promise<void> => {
  const current = await read(snapshot.pid);
  if (
    current === undefined ||
    current.uid !== snapshot.uid ||
    current.startTime !== snapshot.startTime ||
    current.executable !== snapshot.executable ||
    JSON.stringify(current.argv) !== JSON.stringify(snapshot.argv)
  )
    return;
  signal(snapshot.pid);
};

export const stopPerformanceHelpers = async (root: string): Promise<void> => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new PerformanceStoreCleanupError("Cannot establish process ownership");
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      if ((await stat(`/proc/${entry}`)).uid !== uid) continue;
      const snapshot = await readPerformanceProcess(Number(entry));
      if (snapshot === undefined || !isPerformanceRuntimeHelper(snapshot, root)) continue;
      await signalPerformanceProcess(snapshot, readPerformanceProcess, (pid) => {
        try {
          process.kill(pid, "SIGTERM");
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
        }
      });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
};
