import { installProcessLifecycle } from "../../../src/cli/process-lifecycle.ts";
import { runWithProcessSignalReraise } from "../../../src/cli/process-signals.ts";

await installProcessLifecycle();
const keepAlive = setInterval(() => undefined, 60_000);
try {
  await runWithProcessSignalReraise(
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        process.stdout.write("ready\n");
      }),
  );
} finally {
  clearInterval(keepAlive);
}
