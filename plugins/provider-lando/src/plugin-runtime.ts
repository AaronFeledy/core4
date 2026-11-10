import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";

import { type Context, Effect, Schema } from "effect";

import { ProviderUnavailableError, type StateStoreError } from "@lando/sdk/errors";
import type { LandoPluginContext } from "@lando/sdk/plugins";
import type { Downloader, StateBucket } from "@lando/sdk/services";

import type { RuntimeGenerationStore } from "./linux-runtime-generation.ts";
import type { ArtifactDownload, ArtifactDownloadResult } from "./runtime-bundle.ts";
import { type RuntimeShutdownStore, makeRuntimeShutdownStore } from "./runtime-shutdown.ts";

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
  (downloader: Context.Service.Shape<typeof Downloader>): ArtifactDownload =>
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
      mapFailures(
        (cause) =>
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "setup",
            message: cause.message,
            cause,
            remediation: `${cause.remediation} Then run \`lando setup\` to finish installing the Lando runtime.`,
          }),
      ),
    );

export const makePluginRuntimeState = Effect.fnUntraced(function* (ctx: LandoPluginContext): Effect.fn.Return<
  {
    readonly runtimeLock: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | StateStoreError>;
    readonly runtimeGenerationStore: RuntimeGenerationStore;
    readonly runtimeShutdownStore: RuntimeShutdownStore;
  },
  ProviderUnavailableError
> {
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
    .pipe(mapFailures((cause) => providerStateError("Provider runtime state could not be opened.", cause)));
  if (!isStringStateBucket(generationBucketValue)) {
    return yield* Effect.fail(providerStateError("Provider runtime state returned an invalid bucket."));
  }

  return {
    runtimeShutdownStore: yield* makeRuntimeShutdownStore(ctx.stateStore),
    runtimeLock: (body) => ctx.stateStore.withLock("runtime-launch", body),
    runtimeGenerationStore: {
      get: generationBucketValue.get,
      set: (generation) => generationBucketValue.set(generation),
    },
  };
});
