import type { FileHandle } from "node:fs/promises";

import { Effect } from "effect";

import { CacheError } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
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
): Promise<void> =>
  writeFileAtomic(path, content, {
    ...options,
    ...(options.privateFileAccess === undefined ? { ownerOnly: "best-effort" as const } : {}),
  });

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
