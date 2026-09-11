import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Ref } from "effect";
import {
  type OwnerOnlyFileAccess,
  PrivateFileAccessError,
  enforceOwnerOnlyFileAccess,
} from "./private-file-access.ts";

export const syncDirectory = async (path: string): Promise<void> => {
  // Windows does not support opening directories for fsync through this adapter.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

interface CreatedFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;

const removeCreatedFile = async (path: string, identity: CreatedFileIdentity | undefined): Promise<void> => {
  if (identity === undefined) return;
  try {
    const current = await lstat(path);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      await unlink(path);
    }
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
};

/**
 * Atomically replace `path` with `content` under the ambient `Scope`. The write
 * is uninterruptible (a started rename always finishes), and a finalizer cleans
 * up the temp file when the rename did not commit (interrupt or failure).
 *
 * The error channel surfaces the raw filesystem cause for callers to map.
 */
export const writeFileAtomicScoped = (
  path: string,
  content: string | Uint8Array,
  options: {
    readonly randomId?: () => string;
    readonly mode?: number;
    readonly privateFileAccess?: OwnerOnlyFileAccess;
    readonly syncFile?: (handle: FileHandle) => Promise<void>;
    readonly syncDirectory?: (path: string) => Promise<void>;
  } = {},
): Effect.Effect<void, unknown, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempPath = `${path}.tmp-${options.randomId?.() ?? randomUUID()}`;
      const committed = yield* Ref.make(false);
      let identity: CreatedFileIdentity | undefined;

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(committed))) {
            yield* Effect.promise(() => removeCreatedFile(tempPath, identity));
          }
        }),
      );

      yield* Effect.uninterruptible(
        Effect.tryPromise(async () => {
          await mkdir(dirname(path), { recursive: true });
          const handle = await open(tempPath, "wx", options.mode);
          try {
            identity = await handle.stat();
            // The create mode is masked by umask; chmod pins the requested permissions.
            if (options.mode !== undefined) await handle.chmod(options.mode);
            if (
              options.mode === 0o600 &&
              (options.privateFileAccess !== undefined || process.platform === "win32")
            ) {
              await (options.privateFileAccess ?? enforceOwnerOnlyFileAccess)(tempPath);
              const current = await lstat(tempPath);
              if (current.dev !== identity.dev || current.ino !== identity.ino) {
                throw new PrivateFileAccessError(tempPath);
              }
            }
            await handle.writeFile(content);
            // Flush before rename to avoid publishing a torn live file after power loss.
            await (options.syncFile ?? ((h: FileHandle) => h.sync()))(handle);
          } finally {
            await handle.close();
          }
          await rename(tempPath, path);
          await (options.syncDirectory ?? syncDirectory)(dirname(path));
        }),
      );

      yield* Ref.set(committed, true);
    }),
  );
