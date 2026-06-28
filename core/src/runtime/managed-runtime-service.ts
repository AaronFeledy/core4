import { readFile, rm } from "node:fs/promises";

import { Effect } from "effect";

export interface ManagedRuntimeServicePaths {
  readonly runtimeBinDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeStorageDir: string;
  readonly runtimeConfigDir: string;
  readonly providerSocketPath: string;
  readonly providerPidPath: string;
}

export interface ManagedRuntimeServiceSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly pidPath: string;
}

export interface ManagedRuntimeServiceArgsParts {
  readonly runtimeStorageDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeConfigDir: string;
  readonly runtimeBinDir?: string;
  readonly providerSocketPath: string;
}

export interface ProcessSeam {
  readonly readPid: (pidPath: string) => Effect.Effect<string, unknown>;
  readonly isAlive: (pid: number) => Effect.Effect<boolean, unknown>;
  readonly readCmdline: (pid: number) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly terminate: (pid: number) => Effect.Effect<void, unknown>;
}

export interface FsSeam {
  readonly unlink: (path: string) => Effect.Effect<void, unknown>;
}

export interface RuntimeServiceSeams {
  readonly process?: ProcessSeam;
  readonly fs?: FsSeam;
}

type TerminationResult = { readonly terminated: boolean; readonly pid?: number };

const pidPattern = /^\d+$/u;
const emptyArgv: ReadonlyArray<string> = [];

const realProcessSeam: ProcessSeam = {
  readPid: (pidPath) =>
    Effect.tryPromise({
      try: () => readFile(pidPath, "utf8"),
      catch: (cause) => cause,
    }),
  isAlive: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause: unknown) {
        void cause;
        return false;
      }
    }),
  readCmdline: (pid) =>
    Effect.tryPromise({
      try: async () => {
        const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
        return raw.split("\0").filter((part) => part.length > 0);
      },
      catch: (cause) => cause,
    }),
  terminate: (pid) =>
    Effect.try({
      try: () => {
        process.kill(pid, "SIGTERM");
      },
      catch: (cause) => cause,
    }),
};

const realFsSeam: FsSeam = {
  unlink: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => cause,
    }),
};

const parsePid = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!pidPattern.test(trimmed)) return undefined;

  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const sameArgv = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean =>
  actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);

const ownedRuntimePid = (
  spec: ManagedRuntimeServiceSpec,
  processSeam: ProcessSeam,
): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const rawPid = yield* processSeam
      .readPid(spec.pidPath)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (rawPid === undefined) return undefined;

    const pid = parsePid(rawPid);
    if (pid === undefined) return undefined;

    const alive = yield* processSeam.isAlive(pid).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!alive) return undefined;

    const argv = yield* processSeam.readCmdline(pid).pipe(Effect.catchAll(() => Effect.succeed(emptyArgv)));
    return sameArgv(argv, [spec.command, ...spec.args]) ? pid : undefined;
  });

const bestEffortUnlink = (fsSeam: FsSeam, path: string): Effect.Effect<void> =>
  fsSeam.unlink(path).pipe(Effect.catchAll(() => Effect.void));

export const buildManagedRuntimeServiceArgs = (
  parts: ManagedRuntimeServiceArgsParts,
): ReadonlyArray<string> => {
  const storageOptions =
    parts.runtimeBinDir === undefined
      ? []
      : ["--storage-opt", `overlay.mount_program=${parts.runtimeBinDir}/fuse-overlayfs`];

  return [
    "--root",
    parts.runtimeStorageDir,
    "--runroot",
    parts.runtimeRunDir,
    "--config",
    parts.runtimeConfigDir,
    ...storageOptions,
    "system",
    "service",
    "--time=0",
    `unix://${parts.providerSocketPath}`,
  ];
};

// Forward slash is intentional: this is the exact argv[0] the provider spawns and
// the same string matched against `/proc/<pid>/cmdline`, so it must not be re-normalized.
export const managedRuntimePodmanArgv0 = (runtimeBinDir: string): string => `${runtimeBinDir}/podman`;

export const buildManagedRuntimeServiceSpec = (
  paths: ManagedRuntimeServicePaths,
): ManagedRuntimeServiceSpec => ({
  command: managedRuntimePodmanArgv0(paths.runtimeBinDir),
  args: buildManagedRuntimeServiceArgs(paths),
  socketPath: paths.providerSocketPath,
  pidPath: paths.providerPidPath,
});

export const verifyOwnedRuntimePid = (
  spec: ManagedRuntimeServiceSpec,
  processSeam: ProcessSeam = realProcessSeam,
): Effect.Effect<boolean> => ownedRuntimePid(spec, processSeam).pipe(Effect.map((pid) => pid !== undefined));

export const terminateOwnedRuntimeService = (
  spec: ManagedRuntimeServiceSpec,
  seams: RuntimeServiceSeams = {},
): Effect.Effect<TerminationResult> => {
  const processSeam = seams.process ?? realProcessSeam;
  const fsSeam = seams.fs ?? realFsSeam;

  return Effect.gen(function* () {
    const pid = yield* ownedRuntimePid(spec, processSeam);
    const result = yield* Effect.gen(function* () {
      if (pid === undefined) return { terminated: false };

      const terminated = yield* processSeam.terminate(pid).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      return terminated ? { terminated: true, pid } : { terminated: false, pid };
    });

    if (result.terminated) {
      yield* bestEffortUnlink(fsSeam, spec.socketPath);
      yield* bestEffortUnlink(fsSeam, spec.pidPath);
    }

    return result;
  });
};
