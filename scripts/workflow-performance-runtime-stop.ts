import { readFile, readdir, stat } from "node:fs/promises";
import { PerformanceStoreCleanupError } from "./workflow-performance-stores.ts";

export const waitForPerformanceRuntimeStop = async (input: {
  readonly terminate: () => Promise<{ readonly terminated: boolean; readonly pid?: number }>;
  readonly stopped: () => Promise<boolean>;
  readonly timeoutMs: number;
}) => {
  const result = await input.terminate();
  if (!result.terminated || result.pid === undefined)
    throw new PerformanceStoreCleanupError(
      "Runtime ownership/termination was not confirmed; retaining stores",
    );
  const deadline = performance.now() + input.timeoutMs;
  while (!(await input.stopped())) {
    if (performance.now() >= deadline)
      throw new PerformanceStoreCleanupError(
        "Runtime did not stop before cleanup deadline; retaining stores",
      );
    await Bun.sleep(Math.min(50, Math.max(0, deadline - performance.now())));
  }
};

export const performanceRuntimeStopped = async (roots: readonly string[]): Promise<boolean> => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new PerformanceStoreCleanupError("Cannot establish process ownership");
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      if ((await stat(`/proc/${entry}`)).uid !== uid) continue;
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (roots.some((root) => cmdline.includes(root))) return false;
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  return !roots.some((root) => mounts.includes(root.replaceAll(" ", "\\040")));
};
