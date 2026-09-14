import { makeLandoPaths } from "@lando/paths";
import { teardownRuntimeService } from "@lando/provider-lando";
import { Effect } from "effect";
import {
  performanceRuntimeStopped,
  waitForPerformanceRuntimeStop,
} from "./workflow-performance-runtime-stop.ts";

const root = process.env.LANDO_USER_DATA_ROOT;
const runtimeRoot = process.env.XDG_RUNTIME_DIR;
if (root === undefined || runtimeRoot === undefined || process.platform !== "linux") process.exitCode = 1;
else
  await waitForPerformanceRuntimeStop({
    terminate: () =>
      Effect.runPromise(
        Effect.scoped(teardownRuntimeService({ paths: makeLandoPaths({ userDataRoot: root }) })).pipe(
          Effect.timeout("5 seconds"),
        ),
      ),
    stopped: () => performanceRuntimeStopped([root, runtimeRoot]),
    timeoutMs: 20_000,
  });
