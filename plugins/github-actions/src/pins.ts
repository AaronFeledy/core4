import { join } from "node:path";
import { type DownloadRequest, DownloadResult } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import {
  DownloadOptions,
  ImageCandidateRequest,
  RunnerArchiveRequest,
  RuntimeRequest,
  decodePinCatalog,
  pinError,
} from "./pins-schema.ts";
import manifest from "./pins.json";

const loadCatalog = () => decodePinCatalog(manifest);

/** Selection records artifact identity; container compatibility still requires acceptance. */
export const selectNodeRuntime = Effect.fnUntraced(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(RuntimeRequest)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => pinError("unsupported-runtime")));
  const catalog = yield* loadCatalog();
  const runtime = catalog.nodeRuntimes.find(
    (pin) => pin.runtime === request.runtime && pin.arch === request.arch && pin.source === request.source,
  );
  const artifact = catalog.artifacts.find((pin) => pin.id === runtime?.artifactId);
  if (!runtime || !artifact) return yield* Effect.fail(pinError("unsupported-runtime"));
  return { runtime, artifact };
});

export const selectRunnerArchive = Effect.fnUntraced(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(RunnerArchiveRequest)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => pinError("unsupported-runtime")));
  const catalog = yield* loadCatalog();
  const artifact = catalog.artifacts.find(
    (pin) => pin.kind === "runner-archive" && pin.arch === request.arch,
  );
  if (!artifact) return yield* Effect.fail(pinError("unsupported-runtime"));
  return artifact;
});

/** An explicit candidate may be inspected without admitting it for a workload. */
export const selectImageCandidate = Effect.fnUntraced(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(ImageCandidateRequest)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => pinError("unsupported-image")));
  const catalog = yield* loadCatalog();
  const image = catalog.images.find((pin) => pin.id === request.id && pin.arch === request.arch);
  if (!image) return yield* Effect.fail(pinError("unsupported-image"));
  return image;
});
export const selectDefaultImage = () => Effect.fail(pinError("no-reviewed-default"));
export const selectWorkloadImage = (input: unknown) =>
  selectImageCandidate(input).pipe(
    Effect.flatMap(() => Effect.fail(pinError("provider-acceptance-unverified"))),
  );

/**
 * Pure SDK request construction only. The host must supply an owner-private directory
 * and a downloader with appropriate byte, cache, symlink and extraction guarantees.
 */
export const buildDownloadRequest = Effect.fnUntraced(function* (
  input: unknown,
): Effect.fn.Return<DownloadRequest, ReturnType<typeof pinError>> {
  const options = yield* Schema.decodeUnknownEffect(DownloadOptions)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => pinError("invalid-download-request")));
  const catalog = yield* loadCatalog();
  const artifact = catalog.artifacts.find((pin) => pin.id === options.artifactId);
  if (!artifact) return yield* Effect.fail(pinError("invalid-download-request"));
  return {
    url: artifact.url,
    destination: { kind: "file", directory: options.directory, filename: artifact.filename },
    expectedSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes,
    allowFileSource: false,
    offline: options.offline,
    callerId: "github-actions-pins",
  };
});

/**
 * Structural consistency check for a TRUSTED host service receipt. This performs no IO:
 * it does not prove file bytes, cache ownership, symlink safety or safe extraction.
 */
export const validateDownloadResult = Effect.fnUntraced(function* (requestInput: unknown, receipt: unknown) {
  const request = yield* buildDownloadRequest(requestInput);
  if (receipt === undefined)
    return yield* Effect.fail(pinError(request.offline ? "offline-artifact-missing" : "artifact-missing"));
  const result = yield* Schema.decodeUnknownEffect(DownloadResult)(receipt, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => pinError("download-receipt-mismatch")));
  if (
    request.destination.kind !== "file" ||
    result.kind !== "file" ||
    result.url !== request.url ||
    result.sha256 !== request.expectedSha256 ||
    result.sizeBytes !== request.expectedSizeBytes ||
    result.path !== join(request.destination.directory, request.destination.filename) ||
    (request.offline && !result.fromCache)
  )
    return yield* Effect.fail(pinError("download-receipt-mismatch"));
  return result;
});
