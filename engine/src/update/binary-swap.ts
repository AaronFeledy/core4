import { constants, chmod, copyFile, link, rename, rm, stat } from "node:fs/promises";
import { Effect } from "effect";
import type { UpdateError, UpdatePermissionError } from "./errors.ts";

interface BinarySwapPaths {
  readonly executablePath: string;
  readonly stagedBinaryPath: string;
  readonly backupPath: string;
}

export interface BinarySwapFileSystem {
  readonly remove: (path: string) => Promise<void>;
  readonly link: (from: string, to: string) => Promise<void>;
  readonly copy: (from: string, to: string) => Promise<void>;
  readonly stat: (path: string) => Promise<{ readonly mode: number }>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

// Bun's Node-compatible filesystem adapter supplies hardlinks, exclusive copies,
// modes, and replacement renames that Bun.file does not expose.
export const binarySwapFileSystem: BinarySwapFileSystem = {
  remove: (path) => rm(path, { force: true }),
  link,
  copy: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  stat,
  chmod,
  rename,
};

interface BinarySwapOptions {
  readonly fs: BinarySwapFileSystem;
  readonly error: (message: string, cause: unknown) => UpdatePermissionError;
  readonly rollbackError: (error: UpdateError, cause: unknown) => UpdateError;
}

/** Call under the replacement guard, after ownership and staged launch validation. */
export const swapBinary = Effect.fn("Update.swapBinary")(function* <R>(
  paths: BinarySwapPaths,
  verify: Effect.Effect<void, UpdateError, R>,
  options: BinarySwapOptions,
): Effect.fn.Return<void, UpdateError, R> {
  const { executablePath, stagedBinaryPath, backupPath } = paths;
  const { fs, error, rollbackError } = options;
  const backupError = (cause: unknown) =>
    error(`Failed to back up ${executablePath} to ${backupPath}.`, cause);

  // A previous interrupted attempt can leave a hardlink to the live inode here.
  // Unlink only the backup; copying over that inode could corrupt the live file.
  yield* Effect.tryPromise({ try: () => fs.remove(backupPath), catch: backupError });
  yield* Effect.tryPromise({
    try: () => fs.link(executablePath, backupPath),
    catch: backupError,
  }).pipe(
    Effect.catch(() =>
      Effect.tryPromise({
        try: async () => {
          const original = await fs.stat(executablePath);
          await fs.copy(executablePath, backupPath);
          await fs.chmod(backupPath, original.mode & 0o7777);
        },
        catch: backupError,
      }),
    ),
  );

  // Both publication and rollback replace an occupied path atomically. A failed
  // publication leaves the old executable in place and needs no rollback.
  yield* Effect.tryPromise({
    try: () => fs.rename(stagedBinaryPath, executablePath),
    catch: (cause) => error(`Failed to rename ${stagedBinaryPath} to ${executablePath}.`, cause),
  });
  yield* verify.pipe(
    Effect.catch((failure) =>
      Effect.tryPromise({
        try: () => fs.rename(backupPath, executablePath),
        catch: (cause) => rollbackError(failure, cause),
      }).pipe(Effect.andThen(Effect.fail(failure))),
    ),
  );
});
