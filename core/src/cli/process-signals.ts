import { defaultInterruptSignals } from "@lando/engine/runtime/process-signals";

export const runWithProcessSignalReraise = async <T>(
  run: (state: { readonly received: () => NodeJS.Signals | undefined }) => Promise<T>,
): Promise<T> => {
  let received: NodeJS.Signals | undefined;
  const handlers = defaultInterruptSignals().map((signal) => {
    const handler = () => {
      received ??= signal;
    };
    // Keep listeners through cleanup so a second signal cannot bypass finalizers.
    (process as NodeJS.EventEmitter).on(signal, handler);
    return { signal, handler };
  });
  try {
    return await run({ received: () => received });
  } finally {
    for (const { signal, handler } of handlers) (process as NodeJS.EventEmitter).off(signal, handler);
    if (received !== undefined) {
      if (process.platform === "win32") process.exitCode = received === "SIGTERM" ? 143 : 130;
      else process.kill(process.pid, received);
    }
  }
};
