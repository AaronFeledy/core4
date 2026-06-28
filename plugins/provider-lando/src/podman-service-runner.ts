import { readFile, readdir } from "node:fs/promises";

import { Effect } from "effect";

import { buildManagedRuntimeServiceArgs } from "@lando/core/managed-runtime-service";
import { ProviderUnavailableError } from "@lando/sdk/errors";

export interface PodmanServiceSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly socketPath: string;
}

const launchRemediation =
  "The Lando runtime service failed to launch. Run `lando doctor` to inspect the runtime, then rerun the command; run `lando setup` if the runtime is not installed.";

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

export const buildPodmanServiceArgs = (p: {
  readonly podmanBin: string;
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
}): PodmanServiceSpec => ({
  command: p.podmanBin,
  args: buildManagedRuntimeServiceArgs({
    runtimeStorageDir: p.storageDir,
    runtimeRunDir: p.runRoot,
    runtimeConfigDir: p.configDir,
    providerSocketPath: p.socketPath,
  }),
  socketPath: p.socketPath,
});

export interface PodmanServiceRunner {
  readonly launch: (spec: PodmanServiceSpec) => Effect.Effect<number, RuntimeLaunchError>;
  readonly isAlive: (pid: number) => Effect.Effect<boolean>;
  readonly isServiceProcess?: (pid: number, spec: PodmanServiceSpec) => Effect.Effect<boolean>;
  readonly findMatchingServicePids?: (spec: PodmanServiceSpec) => Effect.Effect<ReadonlyArray<number>>;
  readonly terminate: (pid: number) => Effect.Effect<void>;
}

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

export const makeSystemPodmanServiceRunner = (): PodmanServiceRunner => ({
  launch: (spec) =>
    Effect.try({
      try: () => {
        const proc = Bun.spawn([spec.command, ...spec.args], {
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        });
        const detachable = proc as { readonly unref?: () => void };
        detachable.unref?.();
        return proc.pid;
      },
      catch: (cause) =>
        cause instanceof RuntimeLaunchError
          ? cause
          : new RuntimeLaunchError("Failed to launch the Lando runtime service.", cause),
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
  terminate: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }),
});
