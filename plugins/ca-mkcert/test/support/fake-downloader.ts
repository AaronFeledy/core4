import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";

import { DownloadFetchError } from "@lando/sdk/errors";
import type { DownloadRequest, DownloadResult } from "@lando/sdk/schema";
import { Downloader, type DownloaderShape } from "@lando/sdk/services";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface FakeDownloaderHandle {
  readonly layer: Layer.Layer<Downloader>;
  readonly serve: (url: string, bytes: Uint8Array) => void;
  readonly downloadCalls: () => number;
}

export const makeFakeDownloader = (): FakeDownloaderHandle => {
  const sources = new Map<string, Uint8Array>();
  let calls = 0;
  const service: DownloaderShape = {
    id: "fake-downloader",
    capabilities: {
      schemes: ["https", "file"],
      memoryDownload: true,
      cacheAware: true,
      offline: true,
      mirror: false,
    },
    download: (request: DownloadRequest) =>
      Effect.gen(function* () {
        if (request.destination.kind !== "file") {
          return yield* Effect.die(new Error("fake downloader only supports file destinations"));
        }
        const destinationPath = join(request.destination.directory, request.destination.filename);
        if (request.expectedSha256 !== undefined) {
          const existing = yield* Effect.promise(async () => {
            try {
              const bytes = await Bun.file(destinationPath).bytes();
              return { sha256: sha256Hex(bytes), sizeBytes: bytes.length };
            } catch {
              return undefined;
            }
          });
          if (existing !== undefined && existing.sha256 === request.expectedSha256) {
            return {
              url: request.url,
              kind: "file",
              path: destinationPath,
              sha256: existing.sha256,
              sizeBytes: existing.sizeBytes,
              fromCache: true,
            } satisfies DownloadResult;
          }
        }
        if (request.offline === true) {
          return yield* Effect.fail(
            new DownloadFetchError({ message: "offline and not cached", urlOrigin: request.url, status: 0 }),
          );
        }
        calls += 1;
        const body = sources.get(request.url);
        if (body === undefined) {
          return yield* Effect.fail(
            new DownloadFetchError({ message: "no source", urlOrigin: request.url, status: 404 }),
          );
        }
        const result = yield* persistVerifiedStream({
          body: Stream.fromIterable([body]),
          destinationPath,
          ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(new DownloadFetchError({ message: "persist failed", urlOrigin: request.url, cause })),
          ),
        );
        return {
          url: request.url,
          kind: "file",
          path: destinationPath,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          fromCache: false,
        } satisfies DownloadResult;
      }),
  };
  return {
    layer: Layer.succeed(Downloader, service),
    serve: (url, bytes) => void sources.set(url, bytes),
    downloadCalls: () => calls,
  };
};
