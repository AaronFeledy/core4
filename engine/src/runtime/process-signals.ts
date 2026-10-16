/**
 * Process-signal policy for CLI and embedding hosts. Effect-free so the
 * compiled entry can load it on the cold path.
 *
 * A SIGHUP listener overrides nohup's inherited ignore, so hangup is installed
 * only when stdin or stdout is a TTY. On Linux, SigIgn bit 0 is a second gate.
 * SIGINT uses the same inherited-ignore check so background jobs keep the
 * shell's SIG_IGN.
 */
import { readFileSync } from "node:fs";

export const SIGHUP_SIGNAL_NUMBER = 1;
export const SIGINT_SIGNAL_NUMBER = 2;

export interface ProcessSignalHost {
  readonly platform?: NodeJS.Platform;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly sigIgn?: bigint;
  readonly readStatus?: () => string | undefined;
}

const POSIX_INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const WINDOWS_INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;

const readProcSelfStatus = (): string | undefined => {
  try {
    return readFileSync("/proc/self/status", "utf8");
  } catch {
    return undefined;
  }
};

export const parseSigIgnMask = (status: string): bigint | undefined => {
  const match = /^SigIgn:\s*([0-9a-fA-F]+)/mu.exec(status);
  if (match?.[1] === undefined) return undefined;
  try {
    return BigInt(`0x${match[1]}`);
  } catch {
    return undefined;
  }
};

export const isInheritedSignalIgnored = (signalNumber: number, sigIgn: bigint | undefined): boolean =>
  sigIgn !== undefined && (sigIgn & (1n << BigInt(signalNumber - 1))) !== 0n;

export const readLinuxSigIgnMask = (
  readStatus: () => string | undefined = readProcSelfStatus,
): bigint | undefined => {
  const status = readStatus();
  return status === undefined ? undefined : parseSigIgnMask(status);
};

const resolveSigIgn = (host: ProcessSignalHost, platform: NodeJS.Platform): bigint | undefined => {
  if (host.sigIgn !== undefined) return host.sigIgn;
  if (platform !== "linux") return undefined;
  return readLinuxSigIgnMask(host.readStatus);
};

export const shouldHandleSIGHUP = (host: {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly sigIgn?: bigint;
}): boolean =>
  (host.stdinIsTTY || host.stdoutIsTTY) && !isInheritedSignalIgnored(SIGHUP_SIGNAL_NUMBER, host.sigIgn);

export const shouldHandleSIGINT = (host: { readonly sigIgn?: bigint }): boolean =>
  !isInheritedSignalIgnored(SIGINT_SIGNAL_NUMBER, host.sigIgn);

export const defaultInterruptSignals = (
  platformOrHost: NodeJS.Platform | ProcessSignalHost = process.platform,
  host: ProcessSignalHost = {},
): ReadonlyArray<NodeJS.Signals> => {
  const options: ProcessSignalHost =
    typeof platformOrHost === "string" ? { ...host, platform: platformOrHost } : platformOrHost;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return WINDOWS_INTERRUPT_SIGNALS;
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  const sigIgn = resolveSigIgn(options, platform);
  return POSIX_INTERRUPT_SIGNALS.filter((signal) => {
    if (signal === "SIGHUP") {
      return shouldHandleSIGHUP({
        stdinIsTTY,
        stdoutIsTTY,
        ...(sigIgn === undefined ? {} : { sigIgn }),
      });
    }
    if (signal === "SIGINT") return shouldHandleSIGINT(sigIgn === undefined ? {} : { sigIgn });
    return true;
  });
};
