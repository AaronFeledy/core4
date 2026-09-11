import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { CacheError } from "@lando/sdk/errors";
import type { OwnerOnlyFileAccess } from "@lando/state-store/private-file-access";

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly privateFileAccess?: OwnerOnlyFileAccess;
  readonly randomId?: () => string;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
  readonly syncFile?: (handle: FileHandle) => Promise<void>;
}

// Durability contract: the temp file is fsynced before the rename so a power
// loss can never publish a partially written live file.
export const writeFileAtomicViaRename = async (
  path: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${options.randomId?.() ?? randomUUID()}`;
  try {
    const handle = await open(tempPath, "w", options.mode);
    try {
      if (options.mode === 0o600 && options.privateFileAccess !== undefined) {
        await options.privateFileAccess(tempPath);
      }
      await handle.writeFile(content);
      await (options.syncFile ?? ((h: FileHandle) => h.sync()))(handle);
    } finally {
      await handle.close();
    }
    await (options.renameFile ?? rename)(tempPath, path);
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw cause;
  }
};

export const writeAtomicCacheFile = (
  path: string,
  content: string | Uint8Array,
  privateFileAccess?: OwnerOnlyFileAccess,
): Effect.Effect<void, CacheError> =>
  Effect.tryPromise({
    try: () =>
      writeFileAtomicViaRename(path, content, {
        mode: 0o600,
        ...(privateFileAccess === undefined ? {} : { privateFileAccess }),
      }),
    catch: (cause) =>
      new CacheError({
        message: `Failed to atomically write cache file at ${path}.`,
        key: path,
        path,
        cause,
      }),
  });
