import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { decodePinCatalog } from "../src/pins-schema.ts";
import manifest from "../src/pins.json";
import { selectImageCandidate, selectNodeRuntime } from "../src/pins.ts";

const fixtures = resolve(import.meta.dirname, "fixtures/pins");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const catalog = () => structuredClone(manifest);
const rejects = (input: unknown) =>
  expect(Effect.runSync(Effect.flip(decodePinCatalog(input))).reason).toBe("invalid-catalog");

describe("reviewed upstream pin associations", () => {
  test("binds immutable OCI index bytes to platform children and config bytes", async () => {
    const indexBytes = await Bun.file(resolve(fixtures, "runner-image-index.json.raw")).bytes();
    const index = JSON.parse(new TextDecoder().decode(indexBytes));
    expect(`sha256:${hash(indexBytes)}`).toBe(
      "sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690",
    );
    expect(index.manifests).toHaveLength(4);
    for (const arch of ["x64", "arm64"]) {
      const ociArch = arch === "x64" ? "amd64" : arch;
      const selected = Effect.runSync(
        selectImageCandidate({ id: `actions-runner-2.338.1-linux-${arch}`, os: "linux", arch }),
      );
      const childBytes = await Bun.file(
        resolve(fixtures, `runner-image-${ociArch}-manifest.json.raw`),
      ).bytes();
      const configBytes = await Bun.file(
        resolve(fixtures, `runner-image-${ociArch}-config.json.raw`),
      ).bytes();
      const child = JSON.parse(new TextDecoder().decode(childBytes));
      const config = JSON.parse(new TextDecoder().decode(configBytes));
      const descriptor = index.manifests.find(
        (entry: { platform: { architecture: string; os: string } }) =>
          entry.platform.architecture === ociArch && entry.platform.os === "linux",
      );
      expect(descriptor.digest).toBe(`sha256:${hash(childBytes)}`);
      expect(descriptor.size).toBe(childBytes.length);
      expect(selected.indexDigest).toBe(`sha256:${hash(indexBytes)}`);
      expect(selected.manifestDigest).toBe(descriptor.digest);
      expect(selected.configDigest).toBe(child.config.digest);
      expect(child.config.digest).toBe(`sha256:${hash(configBytes)}`);
      expect(child.config.size).toBe(configBytes.length);
      expect(config.architecture).toBe(ociArch);
      expect(config.os).toBe("linux");
      expect(config.config.Labels["org.opencontainers.image.revision"]).toBeUndefined();
      expect(selected.buildProvenance).toBe("unverified");
      for (const attestation of index.manifests.filter(
        (entry: { platform: { os: string } }) => entry.platform.os === "unknown",
      )) {
        expect(selected.manifestDigest).not.toBe(attestation.digest);
      }
    }
  });

  test("retains full exact upstream legal texts with immutable source attribution", async () => {
    for (const notice of manifest.notices) {
      const bytes = await Bun.file(resolve(import.meta.dirname, "../src", notice.path)).bytes();
      expect(hash(bytes)).toBe(notice.sha256);
      expect(new TextDecoder().decode(bytes)).toContain("Permission is hereby granted, free of charge");
      expect(notice.sourceUrl).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/(actions\/runner|nodejs\/node)\/[a-f0-9]{40}\/LICENSE$/u,
      );
      if (notice.id !== "runner") {
        expect(bytes.length).toBeGreaterThan(100_000);
        expect(notice.license).toBe("MIT-with-third-party-notices");
      }
    }
    expect(manifest.images.every((image) => !("license" in image))).toBe(true);
  });

  test("pins the source files that define runner externals versions and relative layout", async () => {
    for (const file of manifest.runner.sourceFiles) {
      const bytes = await Bun.file(
        resolve(fixtures, file.path === "images/Dockerfile" ? "runner-Dockerfile" : "runner-externals.sh"),
      ).bytes();
      expect(hash(bytes)).toBe(file.sha256);
      if (file.path.endsWith("externals.sh")) {
        const source = new TextDecoder().decode(bytes);
        expect(source).toContain('NODE20_VERSION="20.20.2"');
        expect(source).toContain('NODE24_VERSION="24.22.1"');
        expect(source).toContain('target_dir="$LAYOUT_DIR/externals/$2"');
        expect(source).toContain("node20 fix_nested_dir");
        expect(source).toContain("node24 fix_nested_dir");
      }
    }
    // Relative runner layout says nothing about future container mount readiness.
    expect(manifest.nodeRuntimes.every((pin) => pin.containerCompatibility === "unverified")).toBe(true);
  });

  test("validates every exact archive filename, URL, version, platform and notice association", () => {
    expect<unknown>(Effect.runSync(decodePinCatalog(manifest))).toEqual(manifest);
    for (let index = 0; index < manifest.artifacts.length; index++) {
      for (const patch of [
        { id: manifest.artifacts[(index + 1) % manifest.artifacts.length]?.id },
        { filename: "node-latest.tar.gz" },
        { kind: "secret" },
        { version: "2.0" },
        { os: "darwin" },
        { arch: "armv7l" },
        { libc: "musl" },
        { url: "https://secret.invalid" },
        { checksumSourceUrl: "https://secret.invalid" },
        { sha256: "invalid" },
        { sizeBytes: 0 },
        { archive: "zip" },
        { noticeIds: [] },
        { unknown: "secret" },
      ]) {
        const mutated = catalog();
        Object.assign(mutated.artifacts[index] ?? {}, patch);
        rejects(mutated);
      }
      const mutated = catalog();
      const pin = mutated.artifacts[index];
      if (pin) pin.arch = pin.arch === "x64" ? "arm64" : "x64";
      rejects(mutated);
    }
  });

  test("binds all Node member, runtime, ELF and source dimensions and rejects cross-swaps", () => {
    for (let index = 0; index < manifest.nodeRuntimes.length; index++) {
      for (const patch of [
        { id: "secret" },
        { runtime: "node22" },
        { nodeVersion: "20.0.0" },
        { sourceCommit: "0".repeat(40) },
        { source: "bun" },
        { member: "../node" },
        { runnerRelativePath: "/__e/node20/bin/node" },
        { artifactId: manifest.nodeRuntimes[(index + 1) % manifest.nodeRuntimes.length]?.artifactId },
        { containerCompatibility: "accepted" },
        { unknown: "secret" },
      ]) {
        const mutated = catalog();
        Object.assign(mutated.nodeRuntimes[index] ?? {}, patch);
        rejects(mutated);
      }
      for (const patch of [
        { elfMachine: 0 },
        { elfClass: 32 },
        { endianness: "big" },
        { sizeBytes: 0 },
        { sha256: "invalid" },
      ]) {
        const mutated = catalog();
        Object.assign(mutated.nodeRuntimes[index]?.binary ?? {}, patch);
        rejects(mutated);
      }
      const swapped = catalog();
      const pin = swapped.nodeRuntimes[index];
      if (pin) pin.arch = pin.arch === "x64" ? "arm64" : "x64";
      rejects(swapped);
    }
  });

  test("refuses mutable image metadata and caller supplied acceptance or catalog overrides", () => {
    for (let index = 0; index < manifest.images.length; index++)
      for (const patch of [
        { image: "ghcr.io/actions/actions-runner:latest" },
        { os: "unknown" },
        { arch: "unknown" },
        { providerAcceptance: "accepted" },
        { buildProvenance: "verified" },
        { runnerSourceConformanceCommit: "0".repeat(40) },
        { manifestDigest: "mutable" },
        { indexDigest: "mutable" },
        { configDigest: "mutable" },
        { default: true },
        { labels: ["ubuntu-latest"] },
      ]) {
        const mutated = catalog();
        Object.assign(mutated.images[index] ?? {}, patch);
        rejects(mutated);
      }
    expect(
      Effect.runSync(
        Effect.flip(
          selectNodeRuntime({
            runtime: "node20",
            os: "linux",
            arch: "x64",
            libc: "glibc",
            source: "nodejs",
            catalog: manifest,
          }),
        ),
      ).reason,
    ).toBe("unsupported-runtime");
  });

  test("mutating returned pin data cannot change the bundled catalog authority", () => {
    const request = { runtime: "node20", os: "linux", arch: "x64", libc: "glibc", source: "nodejs" };
    const selected = Effect.runSync(selectNodeRuntime(request));
    const original = structuredClone(selected);
    Object.assign(selected.runtime, { runtime: "bun", member: "secret", arch: "arm64" });
    Object.assign(selected.runtime.binary, { sha256: "0".repeat(64), sizeBytes: 1 });
    Object.assign(selected.artifact.noticeIds, { length: 0 });
    Object.assign(selected.artifact, { url: "https://secret.invalid", sha256: "0".repeat(64) });
    expect(Effect.runSync(selectNodeRuntime(request))).toEqual(original);
  });

  test("strict catalog failures carry fixed messages without raw secret values", () => {
    for (const input of [
      { ...catalog(), secret: "secret-data" },
      { ...catalog(), runner: { version: "secret-data" } },
      { ...catalog(), notices: [] },
      { ...catalog(), images: [] },
      { ...catalog(), nodeRuntimes: [] },
      { ...catalog(), artifacts: [] },
    ]) {
      const error = Effect.runSync(Effect.flip(decodePinCatalog(input)));
      expect(error.reason).toBe("invalid-catalog");
      expect(JSON.stringify(error)).not.toContain("secret-data");
      expect(Object.keys(error).sort()).toEqual(["_tag", "reason", "remediation"]);
    }
  });
});
