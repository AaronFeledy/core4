import { readFile, readdir } from "node:fs/promises";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanServiceSpec } from "./podman-service-runner.ts";

export interface PodmanServiceHost {
  readonly isAlive: (pid: number) => boolean;
  readonly readArgv: (pid: number) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly signal: (pid: number) => Effect.Effect<void, unknown>;
}

export class RuntimeTerminationError extends ProviderUnavailableError {
  constructor(pid: number, cause: unknown) {
    super({
      providerId: "lando",
      operation: "setup",
      message: `Failed to terminate managed Lando runtime service PID ${pid}.`,
      remediation: "Stop the managed Lando runtime service, then rerun the command.",
      details: { pid },
      cause,
    });
  }
}

const readProcessArgv = (pid: number): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").filter((part) => part.length > 0);
    },
    catch: () => [],
  }).pipe(Effect.catchAll((argv) => Effect.succeed(argv)));

const defaultHost: PodmanServiceHost = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  readArgv: readProcessArgv,
  signal: (pid) =>
    Effect.try({
      try: () => process.kill(pid, "SIGTERM"),
      catch: (cause) => cause,
    }),
};

const sameArgv = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean =>
  actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);

const argvFlagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index < 0 || index + 1 >= argv.length ? undefined : argv[index + 1];
};

export const isManagedPodmanServiceArgv = (argv: ReadonlyArray<string>, spec: PodmanServiceSpec): boolean => {
  const systemIndex = argv.indexOf("system");
  if (argv[0] !== spec.command || systemIndex < 0 || argv[systemIndex + 1] !== "service") return false;

  const expectedArgv = [spec.command, ...spec.args];
  if (
    argvFlagValue(argv, "--root") !== argvFlagValue(expectedArgv, "--root") ||
    argvFlagValue(argv, "--runroot") !== argvFlagValue(expectedArgv, "--runroot") ||
    argvFlagValue(argv, "--config") !== argvFlagValue(expectedArgv, "--config")
  ) {
    return false;
  }
  return argv.at(-1) === `unix://${spec.socketPath}`;
};

const listProcPids = (): Effect.Effect<ReadonlyArray<number>> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir("/proc");
      return entries.filter((entry) => /^\d+$/u.test(entry)).map(Number);
    },
    catch: () => [] as number[],
  }).pipe(Effect.catchAll(() => Effect.succeed([] as number[])));

export const makePodmanServiceProcessController = (host: PodmanServiceHost = defaultHost) => ({
  isAlive: (pid: number): Effect.Effect<boolean> => Effect.sync(() => host.isAlive(pid)),
  isServiceProcess: (pid: number, spec: PodmanServiceSpec): Effect.Effect<boolean> =>
    host.readArgv(pid).pipe(
      Effect.catchAll(() => Effect.succeed([])),
      Effect.map((argv) => isManagedPodmanServiceArgv(argv, spec)),
    ),
  findMatchingServicePids: (spec: PodmanServiceSpec): Effect.Effect<ReadonlyArray<number>> =>
    Effect.gen(function* () {
      const expected = [spec.command, ...spec.args];
      const matching: number[] = [];
      for (const pid of yield* listProcPids()) {
        const argv = yield* host.readArgv(pid).pipe(Effect.catchAll(() => Effect.succeed([])));
        if (sameArgv(argv, expected)) matching.push(pid);
      }
      return matching;
    }),
  findManagedServicePids: (spec: PodmanServiceSpec): Effect.Effect<ReadonlyArray<number>> =>
    Effect.gen(function* () {
      const matching: number[] = [];
      for (const pid of yield* listProcPids()) {
        const argv = yield* host.readArgv(pid).pipe(Effect.catchAll(() => Effect.succeed([])));
        if (isManagedPodmanServiceArgv(argv, spec)) matching.push(pid);
      }
      return matching;
    }),
  terminate: (pid: number, spec: PodmanServiceSpec): Effect.Effect<void, ProviderUnavailableError> =>
    host.readArgv(pid).pipe(
      Effect.catchAll(() => Effect.succeed([])),
      Effect.flatMap((argv) =>
        isManagedPodmanServiceArgv(argv, spec)
          ? host.signal(pid).pipe(Effect.mapError((cause) => new RuntimeTerminationError(pid, cause)))
          : Effect.void,
      ),
    ),
});
