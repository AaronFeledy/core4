import { mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, parse } from "node:path";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import { launchStatePath } from "./runtime-launch-state.ts";

export interface LinuxRuntimeFilesystem {
  readonly readFile: (path: string) => Effect.Effect<string, unknown>;
  readonly removeFile: (path: string) => Effect.Effect<void, unknown>;
  readonly resetRunRoot: (path: string) => Effect.Effect<void, unknown>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, unknown>;
}

export interface LinuxRuntimeGenerationDeps {
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly bootIdReader?: () => Effect.Effect<string, unknown>;
  readonly pidNamespaceReader?: () => Effect.Effect<string, unknown>;
  readonly filesystem?: LinuxRuntimeFilesystem;
}

export interface LinuxRuntimeGenerationState {
  readonly generation: string;
  readonly reset: boolean;
  readonly filesystem: LinuxRuntimeFilesystem;
}

const liveFilesystem: LinuxRuntimeFilesystem = {
  readFile: (path) => Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }),
  removeFile: (path) => Effect.tryPromise({ try: () => rm(path, { force: true }), catch: (cause) => cause }),
  resetRunRoot: (path) =>
    Effect.tryPromise({
      try: async () => {
        await rm(path, { recursive: true, force: true });
        await mkdir(path, { recursive: true });
      },
      catch: (cause) => cause,
    }),
  writeFile: (path, content) =>
    Effect.tryPromise({ try: () => writeFile(path, content), catch: (cause) => cause }),
};

const generationError = (message: string, remediation: string, details: object, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message,
    remediation,
    details,
    ...(cause === undefined ? {} : { cause }),
  });

const validResetLayout = (deps: LinuxRuntimeGenerationDeps): boolean => {
  const paths = [deps.runRoot, deps.storageDir, deps.configDir, deps.socketPath, deps.pidPath];
  if (paths.some((path) => !isAbsolute(path) || normalize(path) !== path || path === parse(path).root))
    return false;
  if (
    basename(deps.runRoot) !== "run" ||
    basename(deps.storageDir) !== "storage" ||
    basename(deps.configDir) !== "config" ||
    basename(deps.socketPath) !== "podman.sock" ||
    basename(deps.pidPath) !== "podman.pid"
  ) {
    return false;
  }
  const parent = dirname(deps.runRoot);
  return (
    dirname(deps.storageDir) === parent &&
    dirname(deps.configDir) === parent &&
    dirname(deps.socketPath) === deps.runRoot &&
    dirname(deps.pidPath) === deps.runRoot &&
    new Set([deps.runRoot, deps.storageDir, deps.configDir]).size === 3
  );
};

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const readRequiredGenerationPart = (
  read: Effect.Effect<string, unknown>,
  message: string,
  remediation: string,
  details: object,
): Effect.Effect<string, ProviderUnavailableError> =>
  read.pipe(
    Effect.map((value) => value.trim()),
    Effect.mapError((cause) => generationError(message, remediation, details, cause)),
    Effect.filterOrFail(
      (value) => value.length > 0,
      () => generationError(message, remediation, details),
    ),
  );

const livePidNamespace = Effect.tryPromise({
  try: () => readlink("/proc/self/ns/pid"),
  catch: (cause) => cause,
});

export const readLinuxRuntimeGenerationState = (
  deps: LinuxRuntimeGenerationDeps,
): Effect.Effect<LinuxRuntimeGenerationState, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const filesystem = deps.filesystem ?? liveFilesystem;
    const bootId = yield* readRequiredGenerationPart(
      deps.bootIdReader?.() ?? liveFilesystem.readFile("/proc/sys/kernel/random/boot_id"),
      "Failed to read the current kernel boot id.",
      "Verify /proc is available, then rerun the command.",
      { path: "/proc/sys/kernel/random/boot_id" },
    );
    const pidNamespace = yield* readRequiredGenerationPart(
      deps.pidNamespaceReader?.() ?? livePidNamespace,
      "Failed to read the current PID namespace identity.",
      "Verify /proc is available, then rerun the command.",
      { path: "/proc/self/ns/pid" },
    );
    const generation = `${bootId}\n${pidNamespace}`;
    const markerPath = `${deps.runRoot}.generation`;
    const marker = yield* filesystem.readFile(markerPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.catchAll((cause) =>
        isMissingFile(cause)
          ? Effect.succeed(undefined)
          : Effect.fail(
              generationError(
                "Failed to read the Lando runtime generation marker.",
                "Verify the runtime directory is readable, then rerun the command.",
                { markerPath },
                cause,
              ),
            ),
      ),
    );
    const reset = marker !== generation;
    if (reset && !validResetLayout(deps)) {
      return yield* Effect.fail(
        generationError(
          "Refusing to reset an unsafe Lando runtime path layout.",
          "Run `lando doctor` and verify the managed runtime paths.",
          { runRoot: deps.runRoot, storageDir: deps.storageDir, configDir: deps.configDir },
        ),
      );
    }
    return { generation, reset, filesystem };
  });

export const applyLinuxRuntimeGenerationState = (
  deps: LinuxRuntimeGenerationDeps,
  state: LinuxRuntimeGenerationState,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
    if (state.reset) {
      yield* state.filesystem
        .resetRunRoot(deps.runRoot)
        .pipe(
          Effect.mapError((cause) =>
            generationError(
              "Failed to reset the Lando runtime run root after a runtime generation change.",
              "Verify the runtime directory is writable, then rerun the command.",
              { runRoot: deps.runRoot },
              cause,
            ),
          ),
        );
      yield* state.filesystem
        .writeFile(`${deps.runRoot}.generation`, state.generation)
        .pipe(
          Effect.mapError((cause) =>
            generationError(
              "Failed to write the Lando runtime generation marker.",
              "Verify the runtime directory is writable, then rerun the command.",
              { markerPath: `${deps.runRoot}.generation` },
              cause,
            ),
          ),
        );
      return;
    }
    for (const path of [deps.socketPath, deps.pidPath, launchStatePath(deps.pidPath)]) {
      yield* state.filesystem
        .removeFile(path)
        .pipe(
          Effect.mapError((cause) =>
            generationError(
              "Failed to remove stale Lando runtime launch metadata.",
              "Verify the runtime directory is writable, then rerun the command.",
              { path },
              cause,
            ),
          ),
        );
    }
  });
