import { Schema } from "effect";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const HTTPS_URL_PATTERN = /^https:\/\//u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const UpdateChannel = Schema.Literal("stable", "next", "dev");
export type UpdateChannel = typeof UpdateChannel.Type;

export const UpdateManifestPlatform = Schema.Literal(
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
);
export type UpdateManifestPlatform = typeof UpdateManifestPlatform.Type;

export const UpdateManifestHttpsUrl = Schema.String.pipe(
  Schema.pattern(HTTPS_URL_PATTERN, { message: () => "Expected an https:// URL." }),
);
export type UpdateManifestHttpsUrl = typeof UpdateManifestHttpsUrl.Type;

export const UpdateManifestSemver = Schema.String.pipe(
  Schema.pattern(SEMVER_PATTERN, { message: () => "Expected a semantic version." }),
);
export type UpdateManifestSemver = typeof UpdateManifestSemver.Type;

export const UpdateManifestSha256 = Schema.String.pipe(
  Schema.pattern(SHA256_PATTERN, { message: () => "Expected a lowercase SHA-256 hex digest." }),
);
export type UpdateManifestSha256 = typeof UpdateManifestSha256.Type;

export const UpdateManifestBinary = Schema.Struct({
  url: UpdateManifestHttpsUrl,
  sha256: UpdateManifestSha256,
  size: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});
export type UpdateManifestBinary = typeof UpdateManifestBinary.Type;

export const UpdateManifestBinaries = Schema.Struct({
  "darwin-x64": UpdateManifestBinary,
  "darwin-arm64": UpdateManifestBinary,
  "linux-x64": UpdateManifestBinary,
  "linux-arm64": UpdateManifestBinary,
  "windows-x64": UpdateManifestBinary,
});
export type UpdateManifestBinaries = typeof UpdateManifestBinaries.Type;

export const UpdateManifestChecksums = Schema.Struct({
  url: UpdateManifestHttpsUrl,
  signature: UpdateManifestHttpsUrl,
});
export type UpdateManifestChecksums = typeof UpdateManifestChecksums.Type;

export const UpdateManifestSchema = Schema.Struct({
  channel: UpdateChannel,
  latest: UpdateManifestSemver,
  released: Schema.DateTimeUtc,
  minimum: UpdateManifestSemver,
  binaries: UpdateManifestBinaries,
  checksums: UpdateManifestChecksums,
  notes: UpdateManifestHttpsUrl,
});
export type UpdateManifestSchema = typeof UpdateManifestSchema.Type;
