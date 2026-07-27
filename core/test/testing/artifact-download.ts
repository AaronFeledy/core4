import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type Context, Effect } from "effect";

import {
  type ArtifactDownload,
  type ArtifactDownloadResult,
  ProviderBundleChecksumError,
} from "@lando/provider-lando";
import { DownloadChecksumError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { Downloader } from "@lando/sdk/services";

const toRuntimeBundleDownloadError = (cause: unknown): ProviderUnavailableError => {
  if (cause instanceof DownloadChecksumError) {
    return new ProviderBundleChecksumError("The Lando runtime bundle checksum did not match.", cause);
  }
  return new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message: "Failed to download the provider-lando runtime bundle.",
    cause,
  });
};

export const makeArtifactDownload =
  (downloader: Context.Tag.Service<typeof Downloader>): ArtifactDownload =>
  (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* downloader.download({
          url: request.url,
          destination: {
            kind: "file",
            directory: request.directory,
            filename: request.filename,
          },
          expectedSha256: request.expectedSha256,
          ...(request.expectedSizeBytes === undefined
            ? {}
            : { expectedSizeBytes: request.expectedSizeBytes }),
          allowFileSource: request.allowFileSource,
        });
        const path = result.path ?? join(request.directory, request.filename);
        const bytes = yield* Effect.promise(() => readFile(path));
        return {
          bytes: new Uint8Array(bytes),
          sha256: result.sha256,
          path,
        } satisfies ArtifactDownloadResult;
      }),
    ).pipe(Effect.mapError(toRuntimeBundleDownloadError));
