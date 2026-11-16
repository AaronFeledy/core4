/**
 * Identity of the Lando process that created an ephemeral data helper.
 *
 * A helper's lifetime belongs to the process that started its command, so the
 * owner's death is proof that nothing can still be reading the helper's output.
 * The identity below is stamped onto the helper at create time and compared by
 * the stale-helper sweep. Every lookup is best effort: an unknown identity only
 * keeps the helper, it never authorizes removal.
 */
import { readFileSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { sha256Hex } from "@lando/sdk/digest";
import { isErrnoCode } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Option } from "effect";

type HelperProcessRunner = Pick<Context.Service.Shape<typeof ProcessRunner>, "run">;

export interface HelperOwnerIdentity {
  /** First 32 hex of the SHA-256 of the host's native machine id. */
  readonly machine: string;
  /** Linux pid namespace; `host` where the platform has no per-namespace pid view. */
  readonly pidDomain: string;
  readonly pid: number;
  /** Linux boot id, when it can be read. */
  readonly boot?: string;
  /** Linux process start token (field 22 of `/proc/<pid>/stat`). */
  readonly start?: string;
}

export interface OwnerProcessObservation {
  readonly state: "absent" | "present" | "unknown";
  /** The live process's start token when it can be read. */
  readonly start?: string;
}

/** Injectable seams for tests; production defaults live in this module. */
export interface HelperReclaimOptions {
  readonly identity?: Effect.Effect<HelperOwnerIdentity | undefined>;
  readonly probe?: (pid: number) => OwnerProcessObservation;
  readonly isActive?: (name: string) => boolean;
}

const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const PROCESS_COMMAND_TIMEOUT_MS = 5_000;

const activeHelpers = new Set<string>();

export const registerActiveHelper = (name: string): void => {
  activeHelpers.add(name);
};

export const releaseActiveHelper = (name: string): void => {
  activeHelpers.delete(name);
};

export const isActiveHelper = (name: string): boolean => activeHelpers.has(name);

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

export const readProcessStartToken = (pid: number): string | undefined => {
  if (process.platform !== "linux") return undefined;
  try {
    return parseProcessStartToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * `process.kill(pid, 0)` proves absence only with ESRCH. EPERM and every other
 * failure mean "could not tell", which must keep the helper.
 */
export const probeHelperOwnerPid = (pid: number): OwnerProcessObservation => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  try {
    process.kill(pid, 0);
  } catch (cause) {
    return isErrnoCode(cause, "ESRCH") ? { state: "absent" } : { state: "unknown" };
  }
  const start = readProcessStartToken(pid);
  return start === undefined ? { state: "present" } : { state: "present", start };
};

const machineKey = (value: string): string => sha256Hex(value).slice(0, 32);

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
};

const readLinuxPidDomain = async (): Promise<string | undefined> => {
  try {
    const [namespace, self] = await Promise.all([readlink("/proc/self/ns/pid"), readlink("/proc/self")]);
    // The proc view belongs to our namespace only when /proc/self is our pid.
    return self === String(process.pid) && namespace.length > 0 ? namespace : undefined;
  } catch {
    return undefined;
  }
};

const linuxHelperIdentity = async (): Promise<HelperOwnerIdentity | undefined> => {
  let machineId: string | undefined;
  for (const path of MACHINE_ID_PATHS) {
    machineId = (await readOptionalText(path))?.trim();
    if (machineId !== undefined && machineId.length > 0) break;
  }
  if (machineId === undefined || machineId.length === 0) return undefined;
  const pidDomain = await readLinuxPidDomain();
  if (pidDomain === undefined) return undefined;
  const boot = (await readOptionalText(BOOT_ID_PATH))?.trim();
  const start = readProcessStartToken(process.pid);
  return {
    machine: machineKey(machineId),
    pidDomain,
    pid: process.pid,
    ...(boot === undefined || boot.length === 0 ? {} : { boot }),
    ...(start === undefined ? {} : { start }),
  };
};

const runForText = (
  runner: Option.Option<HelperProcessRunner>,
  cmd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string | undefined> => {
  if (Option.isNone(runner)) return Effect.succeed(undefined);
  return runner.value.run({ cmd, args, timeoutMs: PROCESS_COMMAND_TIMEOUT_MS, capture: true }).pipe(
    Effect.map((result) => result.stdout),
    Effect.catchCause(() => Effect.succeed(undefined)),
  );
};

const parseIoregUuid = (output: string): string | undefined =>
  output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/u)?.[1]?.trim() || undefined;

const parseWindowsMachineGuid = (output: string): string | undefined => {
  for (const line of output.split(/\r?\n/u)) {
    const words = line.trim().split(/\s+/u);
    const index = words.indexOf("MachineGuid");
    if (index === -1) continue;
    const next = words[index + 1] === "REG_SZ" ? words[index + 2] : words[index + 1];
    if (next !== undefined && next.length > 0) return next;
  }
  return undefined;
};

const hostBoundHelperIdentity = (
  runner: Option.Option<HelperProcessRunner>,
): Effect.Effect<HelperOwnerIdentity | undefined> =>
  Effect.gen(function* () {
    const machineId = yield* process.platform === "darwin"
      ? runForText(runner, "ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).pipe(
          Effect.map((output) => (output === undefined ? undefined : parseIoregUuid(output))),
        )
      : process.platform === "win32"
        ? runForText(runner, "reg", [
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
          ]).pipe(
            Effect.map((output) => (output === undefined ? undefined : parseWindowsMachineGuid(output))),
          )
        : Effect.succeed(undefined);
    if (machineId === undefined || machineId.length === 0) return undefined;
    // Managed Podman machines run elsewhere: only the host client process is a valid owner.
    return { machine: machineKey(machineId), pidDomain: "host", pid: process.pid };
  });

const captureHelperIdentity = (): Effect.Effect<HelperOwnerIdentity | undefined> =>
  process.platform === "linux"
    ? Effect.promise(linuxHelperIdentity)
    : Effect.gen(function* () {
        const runner = yield* Effect.serviceOption(ProcessRunner);
        return yield* hostBoundHelperIdentity(runner);
      });

let cachedCapture: Effect.Effect<HelperOwnerIdentity | undefined> | undefined;

/** Captures the running process's helper-owner identity once, lazily. */
export const helperOwnerIdentity: Effect.Effect<HelperOwnerIdentity | undefined> = Effect.suspend(() => {
  if (cachedCapture === undefined) {
    // The outer cached effect only allocates the shared memo cell; the capture runs lazily.
    cachedCapture = Effect.runSync(
      Effect.cached(captureHelperIdentity().pipe(Effect.catchCause(() => Effect.succeed(undefined)))),
    );
  }
  return cachedCapture;
});

export const helperOwnerIdentityFor = (
  options: HelperReclaimOptions | undefined,
): Effect.Effect<HelperOwnerIdentity | undefined> => options?.identity ?? helperOwnerIdentity;
