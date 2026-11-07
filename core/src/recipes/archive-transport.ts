/**
 * Downloader-backed archive byte transport for the source-acquisition store.
 * Lives in core (HTTP/Downloader ownership); injected into makeSourceStore transports.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import * as LandoEventService from "@lando/engine/services/event-service";
import { layer as downloaderLayer } from "@lando/http-client/downloader";
import { layer as httpClientLayer } from "@lando/http-client/live";
import { Downloader } from "@lando/sdk/services";
import type { ArchiveTransport } from "@lando/source-acquisition";

export interface AuthenticatedArchiveTransport extends ArchiveTransport {
  readonly fetch: (
    url: string,
    options?: {
      readonly authorization?: string;
      readonly redactionTokens?: ReadonlyArray<string>;
      readonly signal?: AbortSignal;
    },
  ) => Promise<Uint8Array>;
}

export const makeArchiveTransport = (
  retainedDownloader?: typeof Downloader.Service,
  requestContext: Context.Context<never> = Context.empty(),
): AuthenticatedArchiveTransport => ({
  fetch: (url, options) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "lando-archive-fetch-"))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          const downloader = yield* Downloader;
          const result = yield* downloader.download({
            url,
            ...(options?.authorization === undefined
              ? {}
              : { headers: [{ name: "authorization", value: options.authorization }] }),
            ...(options?.redactionTokens === undefined ? {} : { redactionTokens: options.redactionTokens }),
            destination: { kind: "file", directory, filename: "archive" },
          });
          const bytes = yield* Effect.promise(() => readFile(result.path ?? join(directory, "archive")));
          return new Uint8Array(bytes);
        }).pipe(
          Effect.provide(
            retainedDownloader === undefined
              ? downloaderLayer.pipe(
                  Layer.provide(httpClientLayer.pipe(Layer.provide(LandoEventService.layer))),
                )
              : Layer.succeed(Downloader, retainedDownloader),
          ),
          Effect.provide(requestContext),
        ),
      ),
      options?.signal === undefined ? undefined : { signal: options.signal },
    ),
});

export const defaultArchiveTransport = makeArchiveTransport();
