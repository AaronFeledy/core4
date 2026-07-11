import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { buildManagedRuntimeServiceArgs } from "@lando/core/managed-runtime-service";
import { ProviderUnavailableError } from "@lando/sdk/errors";

export interface PodmanServiceSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly socketPath: string;
}

const launchRemediation =
  "The Lando runtime service failed to launch. Run `lando doctor` to inspect the runtime, then rerun the command; run `lando setup` if the runtime is not installed.";
const serviceLogName = "service.log";
const serviceLogTailBytes = 4096;
const serviceLogTailLines = 40;

export const podmanServiceLogPath = (socketPath: string): string =>
  `${dirname(socketPath)}/${serviceLogName}`;

const tailServiceLog = (content: string): string => {
  const bytesTail = content.slice(Math.max(0, content.length - serviceLogTailBytes));
  const lines = bytesTail.split(/\r?\n/u);
  return lines.length > serviceLogTailLines ? lines.slice(-serviceLogTailLines).join("\n") : bytesTail;
};

export const readPodmanServiceLogTail = (socketPath: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const tail = tailServiceLog(await readFile(podmanServiceLogPath(socketPath), "utf8"));
      return tail.length === 0 ? undefined : tail;
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll((tail) => Effect.succeed(tail)));

const readPodmanServiceLogTailSync = (socketPath: string): string | undefined => {
  try {
    const tail = tailServiceLog(readFileSync(podmanServiceLogPath(socketPath), "utf8"));
    return tail.length === 0 ? undefined : tail;
  } catch {
    return undefined;
  }
};

const stderrFromCause = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("stderr" in cause)) return undefined;
  const stderr = (cause as { readonly stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : undefined;
};

export class RuntimeLaunchError extends ProviderUnavailableError {
  constructor(message: string, cause?: unknown, stderr?: string) {
    super({
      providerId: "lando",
      operation: "setup",
      message,
      remediation: launchRemediation,
      cause,
      details: { stderr: stderr ?? stderrFromCause(cause) },
    });
  }

  /**
   * ProviderUnavailableError is an Effect Schema TaggedError whose fields are
   * schema-owned/readonly, so expose stderr by reading the stored details bag
   * instead of mutating the instance after super().
   */
  get stderr(): string | undefined {
    if (typeof this.details !== "object" || this.details === null || !("stderr" in this.details)) {
      return undefined;
    }
    const stderr = (this.details as { readonly stderr?: unknown }).stderr;
    return typeof stderr === "string" ? stderr : undefined;
  }
}

const runtimeBinDirFromPodman = (podmanBin: string): string | undefined => {
  const separator = podmanBin.lastIndexOf("/");
  return separator > 0 ? podmanBin.slice(0, separator) : undefined;
};

export const buildPodmanServiceArgs = (p: {
  readonly podmanBin: string;
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
}): PodmanServiceSpec => {
  const runtimeBinDir = runtimeBinDirFromPodman(p.podmanBin);
  return {
    command: p.podmanBin,
    env: {
      CONTAINERS_CONF: `${p.configDir}/containers.conf`,
      CONTAINERS_REGISTRIES_CONF: `${p.configDir}/registries.conf`,
    },
    args: buildManagedRuntimeServiceArgs({
      runtimeStorageDir: p.storageDir,
      runtimeRunDir: p.runRoot,
      runtimeConfigDir: p.configDir,
      ...(runtimeBinDir === undefined ? {} : { runtimeBinDir }),
      providerSocketPath: p.socketPath,
    }),
    socketPath: p.socketPath,
  };
};

export interface PodmanServiceRunner {
  readonly launch: (spec: PodmanServiceSpec) => Effect.Effect<number, RuntimeLaunchError>;
  readonly isAlive: (pid: number) => Effect.Effect<boolean>;
  readonly isServiceProcess?: (pid: number, spec: PodmanServiceSpec) => Effect.Effect<boolean>;
  readonly findMatchingServicePids?: (spec: PodmanServiceSpec) => Effect.Effect<ReadonlyArray<number>>;
  readonly findManagedServicePids?: (spec: PodmanServiceSpec) => Effect.Effect<ReadonlyArray<number>>;
  readonly terminate: (pid: number) => Effect.Effect<void>;
}

export interface PodmanServiceLaunchOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: number;
  readonly stderr: number;
  readonly detached: true;
}

export interface PodmanServiceProcess {
  readonly pid: number;
  readonly unref?: () => void;
}

export type PodmanServiceSpawn = (
  argv: ReadonlyArray<string>,
  options: PodmanServiceLaunchOptions,
) => PodmanServiceProcess;

const defaultPodmanServiceSpawn: PodmanServiceSpawn = (argv, options) => Bun.spawn([...argv], options);

const readProcessArgv = (pid: number): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").filter((part) => part.length > 0);
    },
    catch: () => [],
  }).pipe(Effect.catchAll((argv) => Effect.succeed(argv)));

const sameArgv = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean =>
  actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);

const argvFlagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
};

const isPodmanSystemServiceArgv = (argv: ReadonlyArray<string>): boolean => {
  const systemIndex = argv.indexOf("system");
  return systemIndex >= 0 && argv[systemIndex + 1] === "service";
};

export const isManagedPodmanServiceArgv = (argv: ReadonlyArray<string>, spec: PodmanServiceSpec): boolean => {
  if (argv[0] !== spec.command || !isPodmanSystemServiceArgv(argv)) return false;

  const expectedArgv = [spec.command, ...spec.args];
  const root = argvFlagValue(argv, "--root");
  const runroot = argvFlagValue(argv, "--runroot");
  const config = argvFlagValue(argv, "--config");
  if (
    root !== argvFlagValue(expectedArgv, "--root") ||
    runroot !== argvFlagValue(expectedArgv, "--runroot") ||
    config !== argvFlagValue(expectedArgv, "--config")
  ) {
    return false;
  }

  const socketBind = argv.at(-1);
  const expectedSocket = `unix://${spec.socketPath}`;
  return socketBind === expectedSocket;
};

const listProcPids = (): Effect.Effect<ReadonlyArray<number>> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir("/proc");
      return entries.filter((entry) => /^\d+$/u.test(entry)).map((entry) => Number(entry));
    },
    catch: () => [] as number[],
  }).pipe(Effect.catchAll(() => Effect.succeed([] as number[])));

const findMatchingServicePidsOnHost = (spec: PodmanServiceSpec): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    const expected = [spec.command, ...spec.args];
    const pids = yield* listProcPids();
    const matching: number[] = [];
    for (const pid of pids) {
      const argv = yield* readProcessArgv(pid);
      if (sameArgv(argv, expected)) matching.push(pid);
    }
    return matching;
  });

const findManagedPodmanServicePidsOnHost = (spec: PodmanServiceSpec): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    const pids = yield* listProcPids();
    const matching: number[] = [];
    for (const pid of pids) {
      const argv = yield* readProcessArgv(pid);
      if (isManagedPodmanServiceArgv(argv, spec)) matching.push(pid);
    }
    return matching;
  });

export const makeSystemPodmanServiceRunner = (
  spawn: PodmanServiceSpawn = defaultPodmanServiceSpawn,
): PodmanServiceRunner => ({
  launch: (spec) =>
    Effect.try({
      try: () => {
        const logPath = podmanServiceLogPath(spec.socketPath);
        mkdirSync(dirname(logPath), { recursive: true });
        const logFile = openSync(logPath, "w");
        const proc = (() => {
          try {
            return spawn([spec.command, ...spec.args], {
              env: { ...process.env, ...spec.env },
              stdout: logFile,
              stderr: logFile,
              detached: true,
            });
          } finally {
            closeSync(logFile);
          }
        })();
        proc.unref?.();
        return proc.pid;
      },
      catch: (cause) =>
        cause instanceof RuntimeLaunchError
          ? cause
          : new RuntimeLaunchError(
              "Failed to launch the Lando runtime service.",
              cause,
              readPodmanServiceLogTailSync(spec.socketPath),
            ),
    }),
  isAlive: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
  isServiceProcess: (pid, spec) =>
    readProcessArgv(pid).pipe(Effect.map((argv) => sameArgv(argv, [spec.command, ...spec.args]))),
  findMatchingServicePids: findMatchingServicePidsOnHost,
  findManagedServicePids: findManagedPodmanServicePidsOnHost,
  terminate: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }),
});
