import { Schema } from "effect";

export const ArtifactManifestEntry = Schema.Struct({
  url: Schema.String,
  sha256: Schema.String,
  filename: Schema.String,
  sizeBytes: Schema.optionalKey(Schema.Number),
});
export type ArtifactManifestEntry = typeof ArtifactManifestEntry.Type;

export const DownloadDestination = Schema.Union([Schema.Struct({ kind: Schema.Literal("file"), directory: Schema.String, filename: Schema.String }), Schema.Struct({ kind: Schema.Literal("memory") })]);
export type DownloadDestination = typeof DownloadDestination.Type;

export const DownloadRequest = Schema.Struct({
  url: Schema.String,
  destination: DownloadDestination,
  expectedSha256: Schema.optionalKey(Schema.String),
  expectedSizeBytes: Schema.optionalKey(Schema.Number),
  allowFileSource: Schema.optionalKey(Schema.Boolean),
  offline: Schema.optionalKey(Schema.Boolean),
  callerId: Schema.optionalKey(Schema.String),
  redactionTokens: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type DownloadRequest = typeof DownloadRequest.Type;

export const DownloadResult = Schema.Struct({
  url: Schema.String,
  kind: Schema.Literals(["file", "memory"]),
  path: Schema.optionalKey(Schema.String),
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  fromCache: Schema.Boolean,
});
export type DownloadResult = typeof DownloadResult.Type;

export const DownloaderCapabilities = Schema.Struct({
  schemes: Schema.Array(Schema.String),
  memoryDownload: Schema.Boolean,
  cacheAware: Schema.Boolean,
  offline: Schema.Boolean,
  mirror: Schema.Boolean,
});
export type DownloaderCapabilities = typeof DownloaderCapabilities.Type;
