import { preserveStdioFileStatusFlags, restoreStdioFileStatusFlags } from "@lando/renderer/native-stdio";
import { runWithProcessSignalReraise } from "../../../src/cli/process-signals.ts";

preserveStdioFileStatusFlags();
const keepAlive = setInterval(() => undefined, 60_000);
try {
  await runWithProcessSignalReraise(
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        process.stdout.write("ready\n");
      }),
    { beforeReraise: restoreStdioFileStatusFlags },
  );
} finally {
  clearInterval(keepAlive);
}
