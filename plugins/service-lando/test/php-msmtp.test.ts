import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import {
  MSMTP_PINS,
  MSMTP_SUPPORTED_FAMILIES,
  MsmtpPinManifest,
  msmtpBuildKeyInput,
  msmtpBuildStepCommand,
  msmtpPinFor,
  resolveMsmtpBaseFamily,
} from "../src/services/php-msmtp.ts";

const config = (input: Record<string, unknown>) => Schema.decodeUnknownSync(ServiceConfig)(input);

describe("msmtp base family resolution", () => {
  test.each([
    [{ type: "php:8.3" }],
    [{ type: "php:8.3", via: "fpm" }],
    [{ type: "php:8.3", via: "cli" }],
    [{ type: "php:8.3", image: "php:8.3-apache-bookworm" }],
  ])("stock PHP services resolve to the bookworm family: %j", (input) => {
    // Given / When
    const family = resolveMsmtpBaseFamily(config(input));
    // Then
    expect(family).toBe("debian-bookworm");
  });

  test.each([
    ["php:8.2-fpm-bullseye", "debian-bullseye"],
    ["php:8.1-apache-bullseye", "debian-bullseye"],
    ["php:8.3-cli-bookworm", "debian-bookworm"],
    ["php:8.3-bookworm", "debian-bookworm"],
    ["docker.io/library/php:8.3-fpm-bookworm", "debian-bookworm"],
  ] as const)("canonical php tags resolve by their explicit suite suffix: %s", (image, expected) => {
    // Given / When
    const family = resolveMsmtpBaseFamily(config({ type: "php:8.3", image }));
    // Then
    expect(family).toBe(expected);
  });

  test.each([
    ["php:8.3-fpm-alpine"],
    ["php:8.3-alpine3.20"],
    ["php:8.3-fpm-trixie"],
    ["my-registry.example/php:8.3-bookworm"],
    ["ghcr.io/acme/app:bookworm"],
    ["acme/php-bookworm:8.3"],
    ["ubuntu:24.04"],
  ])("images without a provable family resolve to undefined: %s", (image) => {
    // Given / When
    const family = resolveMsmtpBaseFamily(config({ type: "php:8.3", image }));
    // Then
    expect(family).toBeUndefined();
  });
});

describe("msmtp pin manifest", () => {
  test("validates and carries one independently pinned record per supported family", () => {
    // Given / When
    const manifest = Schema.decodeUnknownSync(MsmtpPinManifest)(MSMTP_PINS);
    // Then
    expect(Object.keys(manifest.families).sort()).toEqual([...MSMTP_SUPPORTED_FAMILIES].sort());
    expect(manifest.families["debian-bookworm"].version).toBe("1.8.23-1");
    expect(manifest.families["debian-bookworm"].suite).toBe("bookworm");
    expect(manifest.families["debian-bullseye"].version).toBe("1.8.11-2.1");
    expect(manifest.families["debian-bullseye"].suite).toBe("bullseye");
  });

  test("every pinned artifact carries a distinct checksum and a matching url", () => {
    // Given
    const artifacts = Object.values(MSMTP_PINS.families).flatMap((family) => Object.values(family.artifacts));
    // When
    const checksums = new Set(artifacts.map((artifact) => artifact.sha256));
    // Then
    expect(artifacts.length).toBe(4);
    expect(checksums.size).toBe(4);
    for (const artifact of artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.url.endsWith(`/${artifact.file}`)).toBe(true);
      expect(artifact.url.startsWith("https://snapshot.debian.org/archive/debian/")).toBe(true);
    }
  });
});

describe("msmtp build step command", () => {
  test.each([
    ["debian-bookworm", "bookworm", "1.8.23-1", "bullseye", "1.8.11-2.1"],
    ["debian-bullseye", "bullseye", "1.8.11-2.1", "bookworm", "1.8.23-1"],
  ] as const)(
    "installs %s from its own pinned snapshot suite and no other",
    (family, suite, version, otherSuite, otherVersion) => {
      // Given
      const pin = msmtpPinFor(family);
      // When
      const command = msmtpBuildStepCommand(pin, { host: "mail", port: 1025 });
      // Then
      expect(command).toContain(
        `deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${pin.snapshot}/ ${suite} main`,
      );
      expect(command).toContain(`msmtp=${version}`);
      expect(command).not.toContain(otherSuite);
      expect(command).not.toContain(otherVersion);
    },
  );

  test("isolates apt from the image's own sources and leaves no unpinned install", () => {
    // Given
    const pin = msmtpPinFor("debian-bookworm");
    // When
    const command = msmtpBuildStepCommand(pin, { host: "mail", port: 1025 });
    // Then
    expect(command).toContain("-o Dir::Etc::SourceParts=-");
    expect(command).toContain("-o Acquire::Check-Valid-Until=false");
    expect(command).toContain("-o Dir::Etc::SourceList=");
    expect(command).toMatch(/install -y --no-install-recommends msmtp=/u);
    expect(command).not.toMatch(/install -y --no-install-recommends msmtp(?!=)/u);
    expect(command).toContain("rm -rf /var/lib/apt/lists/*");
  });

  test("keeps the sendmail_path wiring for the selected mailpit host and port", () => {
    // Given
    const pin = msmtpPinFor("debian-bookworm");
    // When
    const command = msmtpBuildStepCommand(pin, { host: "inbox", port: 2025 });
    // Then
    expect(command).toContain(
      'sendmail_path = "/usr/bin/msmtp --host=inbox --port=2025 --from=lando@localhost -t"',
    );
    expect(command).toContain("/usr/local/etc/php/conf.d/zz-lando-mailpit.ini");
  });
});

describe("msmtp build key input", () => {
  test("carries the selected family record only, never the whole pin table", () => {
    // Given / When
    const input = msmtpBuildKeyInput(msmtpPinFor("debian-bookworm"));
    // Then
    expect(input).toMatchObject({
      family: "debian-bookworm",
      suite: "bookworm",
      version: "1.8.23-1",
      package: "msmtp",
    });
    expect(input).not.toHaveProperty("families");
    expect(JSON.stringify(input)).not.toContain("bullseye");
  });

  test("repinning one family leaves the other family's build key input untouched", () => {
    // Given
    const baseline = msmtpBuildKeyInput(msmtpPinFor("debian-bookworm"));
    const repinnedBullseye = Schema.decodeUnknownSync(MsmtpPinManifest)({
      ...MSMTP_PINS,
      families: {
        ...MSMTP_PINS.families,
        "debian-bullseye": {
          ...MSMTP_PINS.families["debian-bullseye"],
          snapshot: "20990101T000000Z",
          version: "9.9.9-1",
        },
      },
    });
    // When
    const bookwormAfter = msmtpBuildKeyInput(msmtpPinFor("debian-bookworm", repinnedBullseye));
    const bullseyeAfter = msmtpBuildKeyInput(msmtpPinFor("debian-bullseye", repinnedBullseye));
    // Then
    expect(bookwormAfter).toEqual(baseline);
    expect(bullseyeAfter).not.toEqual(msmtpBuildKeyInput(msmtpPinFor("debian-bullseye")));
    expect(bullseyeAfter).toMatchObject({ version: "9.9.9-1", snapshot: "20990101T000000Z" });
  });
});
