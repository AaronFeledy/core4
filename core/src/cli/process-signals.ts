/**
 * CLI process lifetime for SIGINT/SIGTERM/SIGHUP. After the dispatcher
 * settles, POSIX restores default disposition and re-raises so parent shells
 * see a signal death instead of exit 130/143. Windows keeps those codes.
 */
import { defaultInterruptSignals } from "@lando/engine/runtime/process-signals";

export const SIGINT_EXIT_CODE = 130;
export const SIGTERM_EXIT_CODE = 143;

export interface ProcessSignalEvents {
  once(signal: string, handler: () => void): unknown;
  off(signal: string, handler: () => void): unknown;
}

export interface RunWithProcessSignalReraiseOptions {
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly events?: ProcessSignalEvents;
  readonly setExitCode?: (code: number) => void;
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly sigIgn?: bigint;
}

export const exitCodeForInterruptSignal = (signal: NodeJS.Signals): 130 | 143 | undefined => {
  if (signal === "SIGINT") return SIGINT_EXIT_CODE;
  if (signal === "SIGTERM") return SIGTERM_EXIT_CODE;
  return undefined;
};

export const runWithProcessSignalReraise = async <T>(
  run: (state: { readonly received: () => NodeJS.Signals | undefined }) => Promise<T>,
  options: RunWithProcessSignalReraiseOptions = {},
): Promise<T> => {
  const platform = options.platform ?? process.platform;
  const events = options.events ?? (process as NodeJS.EventEmitter);
  const pid = options.pid ?? process.pid;
  const kill = options.kill ?? ((id, signal) => process.kill(id, signal));
  const setExitCode =
    options.setExitCode ??
    ((code) => {
      process.exitCode = code;
    });
  const signals =
    options.signals ??
    defaultInterruptSignals({
      platform,
      ...(options.stdinIsTTY === undefined ? {} : { stdinIsTTY: options.stdinIsTTY }),
      ...(options.stdoutIsTTY === undefined ? {} : { stdoutIsTTY: options.stdoutIsTTY }),
      ...(options.sigIgn === undefined ? {} : { sigIgn: options.sigIgn }),
    });
  let received: NodeJS.Signals | undefined;
  const handlers = signals.map((signal) => {
    const handler = () => {
      if (received !== undefined) return;
      received = signal;
      if (platform === "win32") {
        const code = exitCodeForInterruptSignal(signal);
        if (code !== undefined) setExitCode(code);
      }
    };
    events.once(signal, handler);
    return { signal, handler };
  });
  try {
    return await run({ received: () => received });
  } finally {
    for (const { signal, handler } of handlers) events.off(signal, handler);
    if (received !== undefined && platform === "win32") {
      const code = exitCodeForInterruptSignal(received);
      if (code !== undefined) setExitCode(code);
    } else if (received !== undefined) {
      kill(pid, received);
    }
  }
};
