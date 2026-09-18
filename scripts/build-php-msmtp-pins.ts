#!/usr/bin/env bun
/**
 * Regenerate `plugins/service-lando/src/services/php-msmtp-pins.json` from
 * reviewed per-family Debian package pins, offline and deterministically.
 *
 * Inputs: MSMTP_FAMILY_PINS below (reviewed, per-family; each family carries its own
 * snapshot timestamp and package version and is repinned independently).
 * Output: plugins/service-lando/src/services/php-msmtp-pins.json
 * To repin ONE family (leave the others untouched):
 *   1. Pick a snapshot timestamp T (format YYYYMMDDTHHMMSSZ) from https://snapshot.debian.org/.
 *   2. For arch in amd64 arm64:
 *        curl -sfL "https://snapshot.debian.org/archive/debian/<T>/dists/<suite>/main/binary-<arch>/Packages.gz" \
 *          | gzip -dc | awk 'BEGIN{RS="\n\n"} /(^|\n)Package: msmtp(\n|$)/' \
 *          | grep -E '^(Version|Filename|Size|SHA256):'
 *   3. Copy Version -> version, the basename of Filename -> file, SHA256 -> sha256, Size -> sizeBytes.
 *   4. Update only that family's record, then run: bun run codegen:php-msmtp-pins
 * Drift gate: re-run + git diff --exit-code on the output.
 */
import { resolve } from "node:path";

import { Schema } from "effect";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "plugins/service-lando/src/services/php-msmtp-pins.json");

const MSMTP_FAMILY_PINS = {
  "debian-bookworm": {
    suite: "bookworm",
    snapshot: "20260101T000000Z",
    package: "msmtp",
    version: "1.8.23-1",
    artifacts: {
      amd64: {
        file: "msmtp_1.8.23-1_amd64.deb",
        sha256: "30acdf76d4f8290a5b6d9b3ac29cb2272579a3217b2156b5a10deed48389ad68",
        sizeBytes: 200720,
      },
      arm64: {
        file: "msmtp_1.8.23-1_arm64.deb",
        sha256: "32b62144a201bbfa7378227fd023e78fc14f6524208185537d94d71251bd717c",
        sizeBytes: 196228,
      },
    },
  },
  "debian-bullseye": {
    suite: "bullseye",
    snapshot: "20260101T000000Z",
    package: "msmtp",
    version: "1.8.11-2.1",
    artifacts: {
      amd64: {
        file: "msmtp_1.8.11-2.1_amd64.deb",
        sha256: "e8b6b0f62be6b23d35e3286a265c84e69420c3ba473814d4787381b272a80204",
        sizeBytes: 175116,
      },
      arm64: {
        file: "msmtp_1.8.11-2.1_arm64.deb",
        sha256: "d20d4012110e38d49f99fee3cda777245ac259da6021f5e0bedd61e6dfbc0085",
        sizeBytes: 170376,
      },
    },
  },
} as const;

const MsmtpArtifact = Schema.Struct({
  file: Schema.String.pipe(Schema.pattern(/^msmtp_[^/]+_(amd64|arm64)\.deb$/u)),
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  sizeBytes: Schema.Number.pipe(Schema.int(), Schema.positive()),
  url: Schema.String.pipe(Schema.startsWith("https://snapshot.debian.org/archive/debian/")),
});
const MsmtpFamily = Schema.Struct({
  suite: Schema.Literal("bookworm", "bullseye"),
  snapshot: Schema.String.pipe(Schema.pattern(/^\d{8}T\d{6}Z$/u)),
  package: Schema.Literal("msmtp"),
  version: Schema.NonEmptyString,
  artifacts: Schema.Struct({ amd64: MsmtpArtifact, arm64: MsmtpArtifact }),
});
const MsmtpPinManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  families: Schema.Struct({ "debian-bookworm": MsmtpFamily, "debian-bullseye": MsmtpFamily }),
});

const main = async (): Promise<void> => {
  const families = Object.fromEntries(
    Object.entries(MSMTP_FAMILY_PINS)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([family, pin]) => [
        family,
        {
          ...pin,
          artifacts: Object.fromEntries(
            (["amd64", "arm64"] as const).map((arch) => {
              const artifact = pin.artifacts[arch];
              return [
                arch,
                {
                  ...artifact,
                  url: `https://snapshot.debian.org/archive/debian/${pin.snapshot}/pool/main/m/msmtp/${artifact.file}`,
                },
              ];
            }),
          ),
        },
      ]),
  );
  const manifest = Schema.decodeUnknownSync(MsmtpPinManifest)({ schemaVersion: 1, families });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await Bun.write(OUTPUT, json);
  console.log(`[build-php-msmtp-pins] wrote ${OUTPUT} (${Object.keys(manifest.families).length} families)`);
};

await main();
