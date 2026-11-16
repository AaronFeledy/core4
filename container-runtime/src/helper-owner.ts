/**
 * Identity of the Lando process that created an ephemeral data helper.
 *
 * A helper's lifetime belongs to the process that started its command, so the
 * owner's death is proof that nothing can still be reading the helper's output.
 * The identity below is stamped onto the helper at create time and compared by
 * the stale-helper sweep. Every lookup is best effort: an unknown identity only
 * keeps the helper, it never authorizes removal.
 *
 * The start token must come from the same native source for our own identity and
 * for a probed owner pid, so both sides read it through `readProcessStartToken`.
 * Where the platform cannot report one, this process records no owner at all and
 * its helpers keep the legacy age rule.
 */
import { readFile, readlink } from "node:fs/promises";
import { sha256Hex } from "@lando/sdk/digest";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, type Option } from "effect";
import { type HelperProcessRunner, runHostText } from "./host-command.ts";
import { type OwnerProcessObservation, readProcessStartToken } from "./process-start-token.ts";

export interface HelperOwnerIdentity {
  /** First 32 hex of the SHA-256 of the host's native machine id. */
  readonly machine: string;
  /** Linux pid namespace; `host` where the platform has no per-namespace pid view. */
  readonly pidDomain: string;
  readonly pid: number;
  /** Linux boot id, when it can be read. */
  readonly boot?: string;
  /**
   * Native process start token. Required: without one this process cannot prove
   * which process a helper belongs to, so it records no owner and the helper
   * keeps the legacy age rule.
   */
  readonly start: string;
}

/** Injectable seams for tests; production defaults live in this module. */
export interface HelperReclaimOptions {
  readonly identity?: Effect.Effect<HelperOwnerIdentity | undefined>;
  readonly probe?: (pid: number) => Effect.Effect<OwnerProcessObservation>;
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

interface LinuxOwnerParts {
  readonly machine: string;
  readonly pidDomain: string;
  readonly boot?: string;
}

const readLinuxOwnerParts = async (): Promise<LinuxOwnerParts | undefined> => {
  let machineId: string | undefined;
  for (const path of MACHINE_ID_PATHS) {
    machineId = (await readOptionalText(path))?.trim();
    if (machineId !== undefined && machineId.length > 0) break;
  }
  if (machineId === undefined || machineId.length === 0) return undefined;
  const pidDomain = await readLinuxPidDomain();
  if (pidDomain === undefined) return undefined;
  const boot = (await readOptionalText(BOOT_ID_PATH))?.trim();
  return {
    machine: machineKey(machineId),
    pidDomain,
    ...(boot === undefined || boot.length === 0 ? {} : { boot }),
  };
};

const linuxHelperIdentity = (): Effect.Effect<HelperOwnerIdentity | undefined> =>
  Effect.gen(function* () {
    const parts = yield* Effect.promise(readLinuxOwnerParts);
    if (parts === undefined) return undefined;
    // The probe reads the same field from /proc/<pid>/stat, so both tokens are comparable.
    const start = yield* readProcessStartToken(process.pid, "linux");
    return start === undefined ? undefined : { ...parts, pid: process.pid, start };
  });

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
      ? runHostText(runner, {
          cmd: "ioreg",
          args: ["-rd1", "-c", "IOPlatformExpertDevice"],
          timeoutMs: PROCESS_COMMAND_TIMEOUT_MS,
        }).pipe(Effect.map((text) => (text === undefined ? undefined : parseIoregUuid(text))))
      : process.platform === "win32"
        ? runHostText(runner, {
            cmd: "reg",
            args: ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
            timeoutMs: PROCESS_COMMAND_TIMEOUT_MS,
          }).pipe(Effect.map((text) => (text === undefined ? undefined : parseWindowsMachineGuid(text))))
        : Effect.succeed(undefined);
    if (machineId === undefined || machineId.length === 0) return undefined;
    // The same reader the probe uses: an owner without a comparable token would let a
    // reused pid keep the helper forever.
    const start = yield* readProcessStartToken(process.pid);
    if (start === undefined) return undefined;
    // Managed Podman machines run elsewhere: only the host client process is a valid owner.
    return { machine: machineKey(machineId), pidDomain: "host", pid: process.pid, start };
  });

const captureHelperIdentity = (): Effect.Effect<HelperOwnerIdentity | undefined> =>
  process.platform === "linux"
    ? linuxHelperIdentity()
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
