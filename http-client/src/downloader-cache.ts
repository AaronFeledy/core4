/**
 * Verified on-disk cache short-circuit for the Downloader.
 */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { Effect } from "effect";

import type { DownloadRequest, DownloadResult } from "@lando/sdk/schema";

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

/** Hash one stable regular-file snapshot. Filesystem failures are cache misses. */
const hashExistingFile = Effect.fnUntraced(
  function* (path: string, expectedSizeBytes: number | undefined) {
    const before = yield* Effect.tryPromise(() => lstat(path, { bigint: true }));
    const sizeBytes = Number(before.size);
    if (
      !before.isFile() ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      (expectedSizeBytes !== undefined && sizeBytes !== expectedSizeBytes)
    ) {
      return undefined;
    }

    // These flags reject leaf symlinks and avoid blocking on a raced FIFO where
    // supported. The identity checks also apply on platforms without the flags.
    const flags =
      constants.O_RDONLY |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
      (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise(() => open(path, flags)),
      (file) => Effect.promise(() => file.close().catch(() => undefined)),
    );
    const initial = yield* Effect.tryPromise(() => handle.stat({ bigint: true }));
    if (!sameFile(before, initial)) return undefined;

    const hash = createHash("sha256");
    const buffer = new Uint8Array(64 * 1024);
    let position = 0;
    while (position < sizeBytes) {
      const { bytesRead } = yield* Effect.tryPromise(() =>
        handle.read(buffer, 0, Math.min(buffer.length, sizeBytes - position), position),
      );
      if (bytesRead === 0) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    // A regular-looking pseudo-file can report size zero yet supply bytes.
    // Probe one byte past the admitted extent without hashing any extra bytes.
    const extra = yield* Effect.tryPromise(() => handle.read(buffer, 0, 1, sizeBytes));
    if (extra.bytesRead !== 0) return undefined;
    const after = yield* Effect.tryPromise(() => handle.stat({ bigint: true }));
    const current = yield* Effect.tryPromise(() => lstat(path, { bigint: true }));
    if (!sameFile(initial, after) || !sameFile(initial, current)) return undefined;

    return { sha256: hash.digest("hex"), sizeBytes };
  },
  Effect.scoped,
  Effect.catch(() => Effect.succeed(undefined)),
);

/** Return a cache hit result when the destination already matches expected checksum/size. */
export const tryCacheHit = Effect.fnUntraced(function* (
  request: DownloadRequest,
  destinationPath: string,
): Effect.fn.Return<DownloadResult | undefined> {
  if (request.expectedSha256 === undefined) return undefined;
  const existing = yield* hashExistingFile(destinationPath, request.expectedSizeBytes);
  if (
    existing === undefined ||
    existing.sha256 !== request.expectedSha256 ||
    (request.expectedSizeBytes !== undefined && existing.sizeBytes !== request.expectedSizeBytes)
  ) {
    return undefined;
  }
  return {
    url: request.url,
    kind: "file",
    path: destinationPath,
    sha256: existing.sha256,
    sizeBytes: existing.sizeBytes,
    fromCache: true,
  } satisfies DownloadResult;
});
