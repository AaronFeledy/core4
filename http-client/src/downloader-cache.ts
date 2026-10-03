/**
 * Verified on-disk cache short-circuit for the Downloader.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { Effect } from "effect";

import type { DownloadRequest, DownloadResult } from "@lando/sdk/schema";

/** Hash an existing destination file, or `undefined` when it is absent/unreadable. */
const hashExistingFile = (
  path: string,
): Effect.Effect<{ readonly sha256: string; readonly sizeBytes: number } | undefined> =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const stream = createReadStream(path);
        stream.on("data", (chunk: string | Buffer) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          hash.update(buf);
          sizeBytes += buf.length;
        });
        stream.on("end", () => resolve({ sha256: hash.digest("hex"), sizeBytes }));
        stream.on("error", () => resolve(undefined));
      }),
  );

/** Return a cache hit result when the destination already matches expected checksum/size. */
export const tryCacheHit = Effect.fnUntraced(function* (
  request: DownloadRequest,
  destinationPath: string,
): Effect.fn.Return<DownloadResult | undefined> {
  if (request.expectedSha256 === undefined) return undefined;
  const existing = yield* hashExistingFile(destinationPath);
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
