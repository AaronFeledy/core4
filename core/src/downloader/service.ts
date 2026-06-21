/**
 * `DownloaderLive` — the verified-artifact specialization layered over the
 * core-private `HttpClient`.
 *
 * Every byte of egress is issued through `HttpClient.stream`; this service never
 * calls `fetch` and never resolves proxy/CA itself, so overriding `HttpClient`
 * governs downloads too. On top of that it adds checksum/size verification,
 * atomic temp-file persistence, cache/offline short-circuiting, and scheme
 * gating. Lifecycle events, redaction, and the contract suite are owned by a
 * later story and are intentionally absent here.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import {
  DownloadChecksumError,
  DownloadFetchError,
  DownloadOfflineError,
  DownloadPersistError,
  DownloadSizeMismatchError,
  DownloadSourceForbiddenError,
} from "@lando/sdk/errors";
import type { DownloadRequest, DownloadResult, DownloaderCapabilities } from "@lando/sdk/schema";
import { Downloader, type DownloaderShape } from "@lando/sdk/services";

import { HttpClient } from "../http-client/service.ts";
import { type VerifiedStreamError, collectVerifiedStream, persistVerifiedStream } from "./verified-stream.ts";

const CAPABILITIES: DownloaderCapabilities = {
  schemes: ["https", "file"],
  memoryDownload: true,
  cacheAware: true,
  offline: true,
  mirror: false,
};

/** Redacted scheme+host origin only — never userinfo, path, or query. */
const urlOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

const statusError = (status: number, origin: string): DownloadFetchError | undefined =>
  status >= 200 && status < 300
    ? undefined
    : new DownloadFetchError({
        message: `The download request failed with HTTP status ${status}.`,
        urlOrigin: origin,
        status,
      });

const validateSource = (request: DownloadRequest): DownloadSourceForbiddenError | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return new DownloadSourceForbiddenError({
      message: "The download URL is not a valid absolute URL.",
      url: request.url,
      reason: "scheme",
    });
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "file:") {
    if (request.allowFileSource === true) return undefined;
    return new DownloadSourceForbiddenError({
      message: "file:// sources are rejected unless the request explicitly allows local sources.",
      url: request.url,
      reason: "file-source",
    });
  }
  return new DownloadSourceForbiddenError({
    message: `The scheme ${parsed.protocol} is not allowed; https:// is the only production scheme.`,
    url: request.url,
    reason: "scheme",
  });
};

const validateDestinationFilename = (filename: string): DownloadSourceForbiddenError | undefined => {
  if (
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".."
  ) {
    return new DownloadSourceForbiddenError({
      message: "The destination filename must be a single path segment within the target directory.",
      reason: "destination-escape",
    });
  }
  return undefined;
};

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

const mapVerifiedError = (error: VerifiedStreamError, origin: string): DownloadError => {
  switch (error.reason) {
    case "checksum":
      return new DownloadChecksumError({
        message: error.message,
        urlOrigin: origin,
        expectedSha256: error.expectedSha256 ?? "",
        actualSha256: error.actualSha256 ?? "",
        ...(error.actualSizeBytes === undefined ? {} : { sizeBytes: error.actualSizeBytes }),
      });
    case "size":
      return new DownloadSizeMismatchError({
        message: error.message,
        urlOrigin: origin,
        expectedSizeBytes: error.expectedSizeBytes ?? 0,
        actualSizeBytes: error.actualSizeBytes ?? 0,
      });
    case "persist":
      return new DownloadPersistError({
        message: error.message,
        operation: "write",
        ...(error.cause === undefined ? {} : { cause: error.cause }),
      });
  }
};

type DownloadError =
  | DownloadFetchError
  | DownloadChecksumError
  | DownloadSizeMismatchError
  | DownloadPersistError
  | DownloadOfflineError
  | DownloadSourceForbiddenError;

export const DownloaderLive: Layer.Layer<Downloader, never, HttpClient> = Layer.effect(
  Downloader,
  Effect.gen(function* () {
    const http = yield* HttpClient;

    const service: DownloaderShape = {
      id: "core-downloader",
      capabilities: CAPABILITIES,
      download: (request) => {
        const origin = urlOrigin(request.url);

        return Effect.gen(function* () {
          const sourceError = validateSource(request);
          if (sourceError !== undefined) return yield* Effect.fail(sourceError);

          if (request.destination.kind === "file") {
            const { directory, filename } = request.destination;
            const destinationError = validateDestinationFilename(filename);
            if (destinationError !== undefined) return yield* Effect.fail(destinationError);
            const destinationPath = join(directory, filename);

            if (request.expectedSha256 !== undefined) {
              const existing = yield* hashExistingFile(destinationPath);
              if (
                existing !== undefined &&
                existing.sha256 === request.expectedSha256 &&
                (request.expectedSizeBytes === undefined || existing.sizeBytes === request.expectedSizeBytes)
              ) {
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
                new DownloadOfflineError({
                  message: "Offline mode is enabled and the artifact is not present in the verified cache.",
                  urlOrigin: origin,
                }),
              );
            }

            const response = yield* http.stream({
              url: request.url,
              allowFileSource: request.allowFileSource ?? false,
            });
            const httpError = statusError(response.status, origin);
            if (httpError !== undefined) return yield* Effect.fail(httpError);
            const result = yield* persistVerifiedStream({
              body: response.body,
              destinationPath,
              expectedSha256: request.expectedSha256,
              expectedSizeBytes: request.expectedSizeBytes,
            });
            return {
              url: request.url,
              kind: "file",
              path: destinationPath,
              sha256: result.sha256,
              sizeBytes: result.sizeBytes,
              fromCache: false,
            } satisfies DownloadResult;
          }

          if (request.offline === true) {
            return yield* Effect.fail(
              new DownloadOfflineError({
                message: "Offline mode is enabled and the artifact is not present in the verified cache.",
                urlOrigin: origin,
              }),
            );
          }

          const response = yield* http.stream({
            url: request.url,
            allowFileSource: request.allowFileSource ?? false,
          });
          const httpError = statusError(response.status, origin);
          if (httpError !== undefined) return yield* Effect.fail(httpError);
          const result = yield* collectVerifiedStream({
            body: response.body,
            expectedSha256: request.expectedSha256,
            expectedSizeBytes: request.expectedSizeBytes,
          });
          return {
            url: request.url,
            kind: "memory",
            sha256: result.sha256,
            sizeBytes: result.sizeBytes,
            fromCache: false,
          } satisfies DownloadResult;
        }).pipe(
          Effect.catchTags({
            HttpStreamError: (error) =>
              Effect.fail(
                new DownloadFetchError({
                  message: error.message,
                  urlOrigin: origin,
                  ...(error.status === undefined ? {} : { status: error.status }),
                  ...(error.cause === undefined ? {} : { cause: error.cause }),
                }),
              ),
            VerifiedStreamError: (error) => Effect.fail(mapVerifiedError(error, origin)),
          }),
        );
      },
    };

    return service;
  }),
);
