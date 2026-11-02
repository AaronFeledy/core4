import { defaultInterruptSignals } from "@lando/engine/runtime/process-signals";
import { reraiseSignal } from "./process-lifecycle.ts";

export const runWithProcessSignalReraise = async <T>(
  run: (state: {
    readonly received: () => NodeJS.Signals | undefined;
    readonly signal: AbortSignal;
  }) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const handlers = defaultInterruptSignals().map((signal) => {
    const handler = () => {
      if (received !== undefined) return;
      received = signal;
      controller.abort(signal);
    };
    // Keep listeners through cleanup so a second signal cannot bypass finalizers.
    (process as NodeJS.EventEmitter).on(signal, handler);
    return { signal, handler };
  });
  try {
    return await run({ received: () => received, signal: controller.signal });
  } finally {
    for (const { signal, handler } of handlers) (process as NodeJS.EventEmitter).off(signal, handler);
    if (received !== undefined) {
      if (process.platform === "win32") process.exitCode = received === "SIGTERM" ? 143 : 130;
      else reraiseSignal(received);
    }
  }
};
