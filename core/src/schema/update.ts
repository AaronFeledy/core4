import { Schema } from "effect";

export const UpdateChannel = Schema.Literal("stable", "next", "dev");
export type UpdateChannel = typeof UpdateChannel.Type;

const HttpsUrl = Schema.String.pipe(Schema.pattern(/^https:\/\//u));
const Semver = Schema.String.pipe(
  Schema.pattern(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    {
      message: () => "Expected a semver version string.",
    },
  ),
);
const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));

export const UpdateManifestPlatform = Schema.Literal(
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
);
export type UpdateManifestPlatform = typeof UpdateManifestPlatform.Type;

export const UpdateManifestBinarySchema = Schema.Struct({
  url: HttpsUrl,
  sha256: Sha256,
  size: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  signature: Schema.optional(HttpsUrl),
  certificate: Schema.optional(HttpsUrl),
});
export type UpdateManifestBinary = typeof UpdateManifestBinarySchema.Type;

export const UpdateManifestSchema = Schema.Struct({
  channel: UpdateChannel,
  latest: Semver,
  released: Schema.String.pipe(Schema.minLength(1)),
  minimum: Semver,
  binaries: Schema.Struct({
    "darwin-x64": UpdateManifestBinarySchema,
    "darwin-arm64": UpdateManifestBinarySchema,
    "linux-x64": UpdateManifestBinarySchema,
    "linux-arm64": UpdateManifestBinarySchema,
    "windows-x64": UpdateManifestBinarySchema,
  }),
  checksums: Schema.Struct({
    url: HttpsUrl,
    signature: HttpsUrl,
  }),
  notes: HttpsUrl,
});
export type UpdateManifest = typeof UpdateManifestSchema.Type;
