/**
 * A process's native start token: the value that separates a live pid from a
 * later process that reused the same pid.
 *
 * The owner identity and every probed owner pid read it through
 * `readProcessStartToken`, so two tokens are always produced the same way and
 * can be compared. Where the platform cannot report a token, the caller learns
 * "unknown" and keeps the helper instead of authorizing removal.
 */
import { readFileSync } from "node:fs";
import { isErrnoCode } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { runHostText } from "./host-command.ts";

type HostPlatform = typeof process.platform;

export interface OwnerProcessObservation {
  readonly state: "absent" | "present" | "unknown";
  /** The live process's start token when it can be read. */
  readonly start?: string;
}

/** Pure description of the native command that reports one pid's start token. */
export interface ProcessStartTokenCommand {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

const START_TOKEN_TIMEOUT_MS = 2_000;

const isProbeablePid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;

export const parseProcessStartToken = (stat: string): string | undefined => {
  // The command name (field 2) may contain spaces and parentheses, so split after its last close.
  const close = stat.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  // Fields after the command name start at field 3; starttime is field 22.
  const token = fields[19];
  return token !== undefined && /^\d+$/u.test(token) ? token : undefined;
};

/** `ps` and PowerShell print one token on its own line; anything else is not usable. */
export const parseStartTokenOutput = (output: string): string | undefined => {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 1 ? lines[0] : undefined;
};

const readLinuxStartToken = (pid: number): string | undefined => {
  try {
    return parseProcessStartToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The native argv that reports a pid's start token. Only a validated positive
 * pid is interpolated; no other text reaches the command.
 */
export const startTokenCommand = (
  platform: HostPlatform,
  pid: number,
): ProcessStartTokenCommand | undefined => {
  if (!isProbeablePid(pid)) return undefined;
  const id = String(pid);
  switch (platform) {
    case "darwin":
      // `lstart` is locale dependent; LC_ALL=C pins one rendering for both sides.
      return { cmd: "ps", args: ["-o", "lstart=", "-p", id], env: { LC_ALL: "C" } };
    case "win32": {
      const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${id}').CreationDate.ToUniversalTime().ToString('o')`;
      return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
    }
    default:
      return undefined;
  }
};

/**
 * Reads a pid's start token from the one native source this platform offers.
 * Our own identity and every probed owner go through this function.
 */
export const readProcessStartToken = (
  pid: number,
  platform: HostPlatform = process.platform,
): Effect.Effect<string | undefined> => {
  if (!isProbeablePid(pid)) return Effect.succeed(undefined);
  if (platform === "linux") return Effect.sync(() => readLinuxStartToken(pid));
  const command = startTokenCommand(platform, pid);
  if (command === undefined) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    const runner = yield* Effect.serviceOption(ProcessRunner);
    const output = yield* runHostText(runner, { ...command, timeoutMs: START_TOKEN_TIMEOUT_MS });
    return output === undefined ? undefined : parseStartTokenOutput(output);
  });
};

const observation = (state: OwnerProcessObservation["state"], start?: string): OwnerProcessObservation =>
  start === undefined ? { state } : { state, start };

/**
 * `process.kill(pid, 0)` proves absence only with ESRCH. EPERM and every other
 * failure mean "could not tell", which must keep the helper.
 */
export const probeHelperOwnerPid = (
  pid: number,
  platform: HostPlatform = process.platform,
): Effect.Effect<OwnerProcessObservation> =>
  Effect.suspend(() => {
    if (!isProbeablePid(pid)) return Effect.succeed(observation("unknown"));
    try {
      process.kill(pid, 0);
    } catch (cause) {
      return Effect.succeed(observation(isErrnoCode(cause, "ESRCH") ? "absent" : "unknown"));
    }
    return readProcessStartToken(pid, platform).pipe(Effect.map((start) => observation("present", start)));
  });
