import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { CacheError } from "@lando/sdk/errors";

const removeIfPresent = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined);
};

export interface AtomicWriteOptions {
  readonly randomId?: () => string;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

export const writeFileAtomicViaRename = async (
  path: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${options.randomId?.() ?? randomUUID()}`;
  try {
    await writeFile(tempPath, content);
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
