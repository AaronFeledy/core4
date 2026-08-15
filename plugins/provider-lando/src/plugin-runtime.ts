import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type Context, Effect, Schema } from "effect";

import { DownloadChecksumError, ProviderUnavailableError, type StateStoreError } from "@lando/sdk/errors";
import type { LandoPluginContext } from "@lando/sdk/plugins";
import type { Downloader, StateBucket } from "@lando/sdk/services";

import type { RuntimeGenerationStore } from "./linux-runtime-generation.ts";
import {
  type ArtifactDownload,
  type ArtifactDownloadResult,
  ProviderBundleChecksumError,
} from "./runtime-bundle.ts";

const providerStateError = (message: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message,
    remediation: "Verify the provider-lando plugin state directory is writable, then retry.",
    ...(cause === undefined ? {} : { cause }),
  });

const isStringStateBucket = (value: unknown): value is StateBucket<string> =>
  typeof value === "object" &&
  value !== null &&
  "get" in value &&
  "set" in value &&
  typeof value.set === "function";

export const makePluginArtifactDownload =
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
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof DownloadChecksumError
          ? new ProviderBundleChecksumError("The Lando runtime bundle checksum did not match.", cause)
          : new ProviderUnavailableError({
              providerId: "lando",
              operation: "setup",
              message: "Failed to download the provider-lando runtime bundle.",
              cause,
            }),
      ),
    );

export const makePluginRuntimeState = (
  ctx: LandoPluginContext,
): Effect.Effect<
  {
    readonly runtimeLock: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | StateStoreError>;
    readonly runtimeGenerationStore: RuntimeGenerationStore;
  },
  ProviderUnavailableError
> =>
  Effect.gen(function* () {
    const generationBucketSpec = {
      id: "runtime-generation.json",
      key: "runtime-generation.json",
      schema: Schema.String,
      version: 1,
      lock: "advisory",
      onCorrupt: "fail",
      onVersionMismatch: "discard",
    } as const;
    const generationBucketValue = yield* ctx.stateStore
      .open(generationBucketSpec)
      .pipe(
        Effect.mapError((cause) => providerStateError("Provider runtime state could not be opened.", cause)),
      );
    if (!isStringStateBucket(generationBucketValue)) {
      return yield* Effect.fail(providerStateError("Provider runtime state returned an invalid bucket."));
    }

    return {
      runtimeLock: (body) => ctx.stateStore.withLock("runtime-launch", body),
      runtimeGenerationStore: {
        get: generationBucketValue.get,
        set: (generation) => generationBucketValue.set(generation),
      },
    };
  });
