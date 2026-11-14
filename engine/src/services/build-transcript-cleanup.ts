import type { Stats } from "node:fs";
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ProviderInternalError } from "@lando/sdk/errors";
import { PathsService, StateStore, type StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { recordCommandWarning } from "../landofile/command-warnings.ts";
import type { BuildOwner } from "./build-owner.ts";
import { clearAppBuildResults, openAppBuildResults, openScratchBuildResults } from "./build-results.ts";
import {
  buildTranscriptError,
  isMissing,
  isWithinUserDataRoot,
  makeBuildTranscriptAppDir,
  makeBuildTranscriptPhaseDir,
} from "./build-transcript.ts";

export interface RemoveBuildTranscriptsInput {
  readonly userDataRoot: string;
  readonly owner: BuildOwner;
  /** Label only: it names the owner in a cleanup failure. */
  readonly providerId?: string;
}

export const removeAppBuildOutput = Effect.fnUntraced(function* (owner: BuildOwner, providerId: string) {
  const stateStore = yield* StateStore;
  const paths = yield* PathsService;
  yield* clearAppBuildResults(stateStore, owner);
  yield* removeBuildTranscripts({ owner, providerId, userDataRoot: paths.roots.userDataRoot });
});

interface SweepBuildTranscriptsInput extends RemoveBuildTranscriptsInput {
  readonly phase: "artifact" | "app";
  /** The index entries that phase uses; their transcript paths are the ones that stay. */
  readonly entries: ReadonlyArray<{
    readonly phase: string;
    readonly transcriptPath: string;
  }>;
}

export interface SweepAppBuildTranscriptsInput extends RemoveBuildTranscriptsInput {
  readonly phase: "artifact" | "app";
  readonly stateStore: StateStoreShape;
  readonly redact: (text: string) => string;
}

const isNotEmpty = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && (cause.code === "ENOTEMPTY" || cause.code === "EEXIST");

export const warnBuildOutputCleanupFailure = (input: {
  readonly providerId: string;
  readonly message: string;
  readonly redact?: (text: string) => string;
}): Effect.Effect<void> =>
  recordCommandWarning({
    code: "LANDO_BUILD_OUTPUT_CLEANUP_FAILED",
    message: input.redact === undefined ? input.message : input.redact(input.message),
    remediation: "Delete the reported path manually or fix its permissions, then rebuild.",
    context: { provider: input.providerId },
  });

/**
 * Remove the app's whole build output directory. A symlink at that path is unlinked, never followed.
 * Best effort: a failure is reported once and never fails the caller.
 */
export const removeBuildTranscripts = (input: RemoveBuildTranscriptsInput): Effect.Effect<void> => {
  const providerId = input.providerId ?? "lando";
  const directory = makeBuildTranscriptAppDir(input);
  return Effect.tryPromise({
    try: async () => {
      let info: Stats;
      try {
        info = await lstat(directory);
      } catch (cause) {
        if (isMissing(cause)) return;
        throw cause;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        // Unlink only an entry whose parent is really inside the data root. The final component is
        // still removed as a link, never followed: a symlinked `builds/` must not reach outside.
        const canonicalParent = await realpath(dirname(directory));
        const canonicalUserDataRoot = await realpath(input.userDataRoot);
        if (!isWithinUserDataRoot(canonicalUserDataRoot, canonicalParent)) {
          throw buildTranscriptError(
            providerId,
            directory,
            "Build output directory escapes the user data root.",
            "remove",
          );
        }
        await rm(directory, { force: true });
        return;
      }
      const [canonicalDirectory, canonicalUserDataRoot] = await Promise.all([
        realpath(directory),
        realpath(input.userDataRoot),
      ]);
      if (!isWithinUserDataRoot(canonicalUserDataRoot, canonicalDirectory)) {
        throw buildTranscriptError(
          providerId,
          directory,
          "Build output directory escapes the user data root.",
          "remove",
        );
      }
      await rm(directory, { recursive: true, force: true });
    },
    catch: (cause) =>
      cause instanceof ProviderInternalError
        ? cause
        : buildTranscriptError(providerId, directory, cause, "remove"),
  }).pipe(Effect.catch((failure) => warnBuildOutputCleanupFailure({ providerId, message: failure.message })));
};

/** Remove a directory the sweep emptied; a non-empty or already-gone directory is the normal case. */
const removeEmptyDirectory = (directory: string): Promise<void> =>
  rmdir(directory).catch((cause) => {
    if (!isMissing(cause) && !isNotEmpty(cause)) throw cause;
  });

/**
 * Remove `*.log` files a phase's index no longer references, then the service directories it left
 * empty. Symlinks are skipped.
 */
const sweepBuildTranscripts = Effect.fnUntraced(function* (input: SweepBuildTranscriptsInput) {
  const providerId = input.providerId ?? "lando";
  const phaseDir = makeBuildTranscriptPhaseDir(input);
  yield* Effect.tryPromise({
    try: async () => {
      let phaseInfo: Stats;
      try {
        phaseInfo = await lstat(phaseDir);
      } catch (cause) {
        if (isMissing(cause)) return;
        throw cause;
      }
      // Only a real directory: a symlinked phase directory is skipped, never followed.
      if (!phaseInfo.isDirectory()) return;
      const [canonicalPhase, canonicalUserDataRoot] = await Promise.all([
        realpath(phaseDir),
        realpath(input.userDataRoot),
      ]);
      if (!isWithinUserDataRoot(canonicalUserDataRoot, canonicalPhase)) {
        throw buildTranscriptError(
          providerId,
          phaseDir,
          "Build output directory escapes the user data root.",
          "remove",
        );
      }
      // Identify a transcript by its place inside this phase directory (service dir + file name), not
      // by absolute path: the user data root can be spelled differently between runs.
      const referenced = new Set(
        input.entries
          .filter((entry) => entry.phase === input.phase)
          .map(
            (entry) => `${basename(dirname(entry.transcriptPath))}\u0000${basename(entry.transcriptPath)}`,
          ),
      );
      // List and remove through the checked real path, so a link swapped in after the check is not
      // followed out of the data root.
      const serviceDirs = await readdir(canonicalPhase, { withFileTypes: true });
      for (const serviceDir of serviceDirs) {
        if (!serviceDir.isDirectory()) continue;
        const directory = join(canonicalPhase, serviceDir.name);
        if ((await realpath(directory)) !== directory) continue;
        const files = await readdir(directory, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".log")) continue;
          const transcript = join(directory, file.name);
          if (referenced.has(`${serviceDir.name}\u0000${file.name}`)) continue;
          await rm(transcript, { force: true });
        }
        await removeEmptyDirectory(directory);
      }
      await removeEmptyDirectory(canonicalPhase);
    },
    catch: (cause) =>
      cause instanceof ProviderInternalError
        ? cause
        : buildTranscriptError(providerId, phaseDir, cause, "remove"),
  });
});

/** Sweep the phase directory an index this app owns uses. Best effort: never fails the build. */
export const sweepAppBuildTranscripts = (input: SweepAppBuildTranscriptsInput): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Only a scratch plan's image phase shares its index; every app phase uses the per-app index.
    const entries =
      (yield* (
        input.phase === "artifact" && input.owner.kind === "scratch"
          ? openScratchBuildResults(input.stateStore)
          : openAppBuildResults(input.stateStore, input.owner)
      ).pipe(Effect.flatMap((bucket) => bucket.get))) ?? [];
    yield* sweepBuildTranscripts({ ...input, entries });
  }).pipe(
    Effect.catch((failure) =>
      warnBuildOutputCleanupFailure({
        providerId: input.providerId ?? "lando",
        message: failure.message,
        redact: input.redact,
      }),
    ),
  );
