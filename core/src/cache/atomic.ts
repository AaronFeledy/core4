import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { CacheError } from "@lando/sdk/errors";

const removeIfPresent = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined);
};

export interface AtomicWriteOptions {
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
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(content);
      await (options.syncFile ?? ((h: FileHandle) => h.sync()))(handle);
    } finally {
      await handle.close();
    }
    await (options.renameFile ?? rename)(tempPath, path);
  } catch (cause) {
    await removeIfPresent(tempPath);
    throw cause;
  }
};

export const writeAtomicCacheFile = (
  path: string,
  content: string | Uint8Array,
): Effect.Effect<void, CacheError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(path, content),
    catch: (cause) =>
      new CacheError({
        message: `Failed to atomically write cache file at ${path}.`,
        key: path,
        path,
        cause,
      }),
  });
