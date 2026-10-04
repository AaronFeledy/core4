import { Schema } from "effect";
import { SEMVER_LOOSE_PATTERN, SHA256_HEX_PATTERN, patternString } from "./string-forms.ts";

const HTTPS_URL_PATTERN = /^https:\/\//u;

export const UpdateChannel = Schema.Literals(["stable", "next", "dev"]);
export type UpdateChannel = typeof UpdateChannel.Type;

export const UpdateManifestPlatform = Schema.Literals([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
]);
export type UpdateManifestPlatform = typeof UpdateManifestPlatform.Type;

export const UpdateManifestHttpsUrl = patternString(HTTPS_URL_PATTERN, {
  message: "Expected an https:// URL.",
});
export type UpdateManifestHttpsUrl = typeof UpdateManifestHttpsUrl.Type;

export const UpdateManifestSemver = patternString(SEMVER_LOOSE_PATTERN, {
  message: "Expected a semantic version.",
});
export type UpdateManifestSemver = typeof UpdateManifestSemver.Type;

export const UpdateManifestSha256 = patternString(SHA256_HEX_PATTERN, {
  message: "Expected a lowercase SHA-256 hex digest.",
});
export type UpdateManifestSha256 = typeof UpdateManifestSha256.Type;

export const UpdateManifestBinary = Schema.Struct({
  url: UpdateManifestHttpsUrl,
  sha256: UpdateManifestSha256,
  size: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
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
  released: Schema.DateTimeUtcFromString,
  minimum: UpdateManifestSemver,
  binaries: UpdateManifestBinaries,
  checksums: UpdateManifestChecksums,
  notes: UpdateManifestHttpsUrl,
});
export type UpdateManifestSchema = typeof UpdateManifestSchema.Type;
