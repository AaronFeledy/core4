import { mkdir, readFile, readlink, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, parse } from "node:path";

import { Effect } from "effect";

import { ProviderUnavailableError, type StateStoreError } from "@lando/sdk/errors";

import { launchStatePath } from "./runtime-launch-state.ts";

export interface RuntimeGenerationStore {
  readonly get: Effect.Effect<string | null, StateStoreError>;
  readonly set: (generation: string) => Effect.Effect<void, StateStoreError>;
}

export interface LinuxRuntimeFilesystem {
  readonly removeFile: (path: string) => Effect.Effect<void, unknown>;
  readonly resetRunRoot: (path: string) => Effect.Effect<void, unknown>;
}

export interface LinuxRuntimeGenerationDeps {
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly generationStore: RuntimeGenerationStore;
  readonly bootIdReader?: () => Effect.Effect<string, unknown>;
  readonly pidNamespaceReader?: () => Effect.Effect<string, unknown>;
  readonly filesystem?: LinuxRuntimeFilesystem;
}

export type LinuxRuntimeGenerationState =
  | { readonly kind: "current"; readonly generation: string; readonly filesystem: LinuxRuntimeFilesystem }
  | { readonly kind: "missing"; readonly generation: string; readonly filesystem: LinuxRuntimeFilesystem }
  | {
      readonly kind: "changed";
      readonly generation: string;
      readonly previous: string;
      readonly filesystem: LinuxRuntimeFilesystem;
    };

const liveFilesystem: LinuxRuntimeFilesystem = {
  removeFile: (path) => Effect.tryPromise({ try: () => rm(path, { force: true }), catch: (cause) => cause }),
  resetRunRoot: (path) =>
    Effect.tryPromise({
      try: async () => {
        await rm(path, { recursive: true, force: true });
        await mkdir(path, { recursive: true });
      },
      catch: (cause) => cause,
    }),
};

const generationError = (message: string, details: object, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message,
    remediation: "Verify the managed runtime directory and /proc are accessible, then retry the command.",
    details,
    ...(cause === undefined ? {} : { cause }),
  });

const validResetLayout = (deps: LinuxRuntimeGenerationDeps): boolean => {
  const paths = [deps.runRoot, deps.storageDir, deps.configDir, deps.socketPath, deps.pidPath];
  if (paths.some((path) => !isAbsolute(path) || normalize(path) !== path || path === parse(path).root)) {
    return false;
  }
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
    dirname(deps.pidPath) === deps.runRoot
  );
};

const readGenerationPart = (
  effect: Effect.Effect<string, unknown>,
  path: string,
): Effect.Effect<string, ProviderUnavailableError> =>
  effect.pipe(
    Effect.map((value) => value.trim()),
    Effect.mapError((cause) =>
      generationError("Failed to read the current Linux runtime generation.", { path }, cause),
    ),
    Effect.filterOrFail(
      (value) => value.length > 0,
      () => generationError("The current Linux runtime generation is empty.", { path }),
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
    const bootId = yield* readGenerationPart(
      deps.bootIdReader?.() ??
        Effect.tryPromise({
          try: () => readFile("/proc/sys/kernel/random/boot_id", "utf8"),
          catch: (cause) => cause,
        }),
      "/proc/sys/kernel/random/boot_id",
    );
    const pidNamespace = yield* readGenerationPart(
      deps.pidNamespaceReader?.() ?? livePidNamespace,
      "/proc/self/ns/pid",
    );
    const generation = `${bootId}\n${pidNamespace}`;
    const marker = yield* deps.generationStore.get.pipe(
      Effect.mapError((cause) =>
        generationError("Failed to read the Lando runtime generation marker.", {}, cause),
      ),
    );
    const filesystem = deps.filesystem ?? liveFilesystem;
    if (marker === null) return { kind: "missing", generation, filesystem };
    return marker === generation
      ? { kind: "current", generation, filesystem }
      : { kind: "changed", generation, previous: marker, filesystem };
  });

export const adoptHealthyRuntimeGeneration = (
  deps: LinuxRuntimeGenerationDeps,
): Effect.Effect<boolean, ProviderUnavailableError> =>
  readLinuxRuntimeGenerationState(deps).pipe(
    Effect.flatMap((state) => {
      switch (state.kind) {
        case "current":
          return Effect.succeed(true);
        case "missing":
          return deps.generationStore.set(state.generation).pipe(
            Effect.mapError((cause) =>
              generationError("Failed to adopt the healthy Lando runtime generation.", {}, cause),
            ),
            Effect.as(true),
          );
        case "changed":
          return Effect.succeed(false);
      }
    }),
  );

export const applyLinuxRuntimeGenerationState = (
  deps: LinuxRuntimeGenerationDeps,
  state: LinuxRuntimeGenerationState,
): Effect.Effect<void, ProviderUnavailableError> => {
  if (state.kind === "current") {
    return Effect.forEach(
      [deps.socketPath, deps.pidPath, launchStatePath(deps.pidPath)],
      (path) =>
        state.filesystem
          .removeFile(path)
          .pipe(
            Effect.mapError((cause) =>
              generationError("Failed to remove stale Lando runtime launch metadata.", { path }, cause),
            ),
          ),
      { discard: true },
    );
  }
  if (!validResetLayout(deps)) {
    return Effect.fail(
      generationError("Refusing to reset an unsafe Lando runtime path layout.", {
        runRoot: deps.runRoot,
        storageDir: deps.storageDir,
        configDir: deps.configDir,
      }),
    );
  }
  return state.filesystem.resetRunRoot(deps.runRoot).pipe(
    Effect.mapError((cause) =>
      generationError("Failed to reset the stale Lando runtime runroot.", { runRoot: deps.runRoot }, cause),
    ),
    Effect.zipRight(
      deps.generationStore
        .set(state.generation)
        .pipe(
          Effect.mapError((cause) =>
            generationError("Failed to record the current Lando runtime generation.", {}, cause),
          ),
        ),
    ),
  );
};
