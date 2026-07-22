import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { buildManagedRuntimeServiceArgs } from "@lando/core/managed-runtime-service";
import { ProviderUnavailableError } from "@lando/sdk/errors";

import { type PodmanServiceHost, makePodmanServiceProcessController } from "./podman-service-process.ts";

export { RuntimeTerminationError, isManagedPodmanServiceArgv } from "./podman-service-process.ts";
export type { PodmanServiceHost } from "./podman-service-process.ts";

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
      XDG_CONFIG_HOME: p.configDir,
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
  readonly terminate: (pid: number, spec: PodmanServiceSpec) => Effect.Effect<void, ProviderUnavailableError>;
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

export interface SystemPodmanServiceRunnerOptions {
  readonly spawn?: PodmanServiceSpawn;
  readonly host?: PodmanServiceHost;
}

const defaultPodmanServiceSpawn: PodmanServiceSpawn = (argv, options) => Bun.spawn([...argv], options);

export const makeSystemPodmanServiceRunner = (
  options: SystemPodmanServiceRunnerOptions = {},
): PodmanServiceRunner => {
  const spawn = options.spawn ?? defaultPodmanServiceSpawn;
  const processes = makePodmanServiceProcessController(options.host);
  return {
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
    isAlive: processes.isAlive,
    isServiceProcess: processes.isServiceProcess,
    findMatchingServicePids: processes.findMatchingServicePids,
    findManagedServicePids: processes.findManagedServicePids,
    terminate: processes.terminate,
  };
};
