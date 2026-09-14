import { readFile } from "node:fs/promises";
import { makeLandoPaths } from "@lando/paths";
import { teardownRuntimeService } from "@lando/provider-lando";
import { Effect } from "effect";
import { runWorkflowPerformanceCommand } from "./workflow-performance-command.ts";
import { readPerformanceProcess, stopPerformanceHelpers } from "./workflow-performance-processes.ts";
import {
  performanceRuntimeStopped,
  waitForPerformanceRuntimeQuiescence,
  waitForPerformanceRuntimeStop,
} from "./workflow-performance-runtime-stop.ts";
import { PerformanceStoreCleanupError, unmountPerformanceOverlay } from "./workflow-performance-stores.ts";

const root = process.env.LANDO_USER_DATA_ROOT;
const runtimeRoot = process.env.XDG_RUNTIME_DIR;
if (root === undefined || runtimeRoot === undefined || process.platform !== "linux") process.exitCode = 1;
else {
  const paths = makeLandoPaths({ userDataRoot: root });
  try {
    if (!process.argv.includes("--helpers-only")) {
      const pid = Number((await readFile(paths.providerPidPath, "utf8")).trim());
      const service = await readPerformanceProcess(pid);
      if (service === undefined || service.uid !== process.getuid?.())
        throw new PerformanceStoreCleanupError("Cannot establish service identity; retaining stores");
      await waitForPerformanceRuntimeStop({
        terminate: async () => {
          const current = await readPerformanceProcess(pid);
          if (
            current?.startTime !== service.startTime ||
            current.uid !== service.uid ||
            current.executable !== service.executable
          )
            return { terminated: false };
          return Effect.runPromise(Effect.scoped(teardownRuntimeService({ paths })));
        },
        stopped: async () => (await readPerformanceProcess(pid))?.startTime !== service.startTime,
        timeoutMs: 5_000,
      });
      await stopPerformanceHelpers(root);
      await waitForPerformanceRuntimeQuiescence(() => performanceRuntimeStopped([root, runtimeRoot]), 5_000);
      const unmount = await runWorkflowPerformanceCommand({
        id: "cleanup:unmount",
        argv: [
          `${paths.runtimeBinDir}/podman`,
          "--root",
          paths.runtimeStorageDir,
          "--runroot",
          paths.runtimeRunDir,
          "unshare",
          "sh",
          "-ec",
          unmountPerformanceOverlay,
          "sh",
          paths.runtimeStorageDir,
        ],
        cwd: process.cwd(),
        env: { ...process.env, CONTAINERS_CONF: `${paths.runtimeConfigDir}/containers.conf` },
        timeoutMs: 10_000,
      });
      if (unmount.exitCode !== 0) throw new PerformanceStoreCleanupError(unmount.stderr);
    }
  } finally {
    await stopPerformanceHelpers(root);
    await waitForPerformanceRuntimeQuiescence(() => performanceRuntimeStopped([root, runtimeRoot]), 5_000);
  }
}
