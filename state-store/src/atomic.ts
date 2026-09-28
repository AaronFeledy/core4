import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { isErrnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";
import { type OwnerOnlyFileAccess, PrivateFileAccessError } from "./private-file-access.ts";

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

const removeCreatedFile = async (
  path: string,
  identity: CreatedFileIdentity | undefined,
  remove: (path: string) => Promise<void> = unlink,
): Promise<void> => {
  if (identity === undefined) return;
  try {
    const current = await lstat(path);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      await remove(path);
    }
  } catch (cause) {
    if (!isErrnoCode(cause, "ENOENT")) throw cause;
  }
};

export interface WriteFileAtomicOptions {
  readonly mode?: number;
  readonly privateFileAccess?: OwnerOnlyFileAccess;
  /** Strict (default) requires Windows owner-only ACLs; best-effort pins mode only, without ACL enforcement or identity verification. */
  readonly ownerOnly?: "strict" | "best-effort";
  readonly randomId?: () => string;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
  readonly syncFile?: (handle: FileHandle) => Promise<void>;
  readonly syncDirectory?: (dir: string) => Promise<void>;
  readonly removeFile?: (path: string) => Promise<void>;
  /** @internal Allows the scoped adapter to retain ownership for its finalizer. */
  readonly onTempCreated?: (path: string, identity: CreatedFileIdentity) => void;
}

export const writeFileAtomic = async (
  path: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${options.randomId?.() ?? randomUUID()}`;
  let identity: CreatedFileIdentity | undefined;
  let committed = false;
  try {
    const handle = await open(tempPath, "wx", options.mode);
    try {
      identity = await handle.stat();
      options.onTempCreated?.(tempPath, identity);
      // The create mode is masked by umask; chmod pins the requested permissions.
      if (options.mode !== undefined) await handle.chmod(options.mode);
      if (options.ownerOnly !== "best-effort") {
        if (
          options.mode === 0o600 &&
          process.platform === "win32" &&
          options.privateFileAccess === undefined
        ) {
          throw new PrivateFileAccessError(tempPath);
        }
        if (options.mode === 0o600 && options.privateFileAccess !== undefined) {
          await options.privateFileAccess(tempPath);
          const current = await lstat(tempPath);
          if (current.dev !== identity.dev || current.ino !== identity.ino) {
            throw new PrivateFileAccessError(tempPath);
          }
        }
      }
      await handle.writeFile(content);
      await (options.syncFile ?? ((h: FileHandle) => h.sync()))(handle);
    } finally {
      await handle.close();
    }
    await (options.renameFile ?? rename)(tempPath, path);
    committed = true;
    await (options.syncDirectory ?? syncDirectory)(dirname(path));
  } catch (cause) {
    if (!committed) {
      try {
        await removeCreatedFile(tempPath, identity, options.removeFile);
      } catch {
        // Temp removal is best-effort; preserve the original write failure.
      }
    }
    throw cause;
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
      const id = options.randomId?.() ?? randomUUID();
      const tempPath = `${path}.tmp-${id}`;
      let committed = false;
      let identity: CreatedFileIdentity | undefined;

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!committed) {
            yield* Effect.promise(() => removeCreatedFile(tempPath, identity));
          }
        }),
      );

      yield* Effect.uninterruptible(
        Effect.tryPromise(() =>
          writeFileAtomic(path, content, {
            ...options,
            randomId: () => id,
            onTempCreated: (_path, createdIdentity) => {
              identity = createdIdentity;
            },
            renameFile: async (from, to) => {
              await rename(from, to);
              committed = true;
            },
          }),
        ),
      );
    }),
  );
