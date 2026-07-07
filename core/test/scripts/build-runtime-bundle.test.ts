import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { makeDefaultRuntimeBundleDownloader } from "@lando/provider-lando";
import { Downloader } from "@lando/sdk/services";

import {
  LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT,
  RUNTIME_BUNDLE_TARGETS,
  buildRuntimeBundleManifest,
  computeBundleEntry,
  releaseBundleBaseUrl,
  releaseBundleUrl,
  resolveRuntimeBundleRepository,
} from "../../../scripts/build-runtime-bundle.ts";
import { DownloaderLive } from "../../src/downloader/service.ts";
import { HttpClientLive } from "../../src/http-client/live.ts";
import { makeArtifactDownload } from "../../src/providers/registry.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const fileUrl = (path: string): string => new URL(`file://${path}`).href;

const coreArtifactDownload = Effect.gen(function* () {
  const downloader = yield* Downloader;
  return makeArtifactDownload(downloader);
}).pipe(Effect.provide(DownloaderLive.pipe(Layer.provide(HttpClientLive))));

describe("RUNTIME_BUNDLE_TARGETS", () => {
  test("covers every supported host platform key with a basename-only filename", () => {
    expect(RUNTIME_BUNDLE_TARGETS.map((target) => target.key).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    for (const target of RUNTIME_BUNDLE_TARGETS) {
      expect(target.filename).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });
});

describe("computeBundleEntry", () => {
  test("computes the SHA-256 and size of a staged artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-build-entry-"));
    try {
      const bytes = new TextEncoder().encode("staged-runtime-bundle");
      const artifactPath = join(dir, "lando-runtime-linux-x64.tar.gz");
      await writeFile(artifactPath, bytes);

      const entry = await computeBundleEntry(artifactPath, fileUrl(artifactPath));
      expect(entry.sha256).toBe(sha256(bytes));
      expect(entry.sizeBytes).toBe(bytes.byteLength);
      expect(entry.filename).toBe("lando-runtime-linux-x64.tar.gz");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildRuntimeBundleManifest (--local)", () => {
  test("emits only the platforms whose artifacts are staged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-build-local-"));
    try {
      const bytes = new TextEncoder().encode("linux-bundle");
      await writeFile(join(dir, "lando-runtime-linux-x64.tar.gz"), bytes);

      const manifest = await buildRuntimeBundleManifest({
        stagingDir: dir,
        runtimeVersion: "1.2.3",
        targets: RUNTIME_BUNDLE_TARGETS,
        urlFor: (_target, artifactPath) => fileUrl(artifactPath),
      });

      expect(Object.keys(manifest.bundles)).toEqual(["linux-x64"]);
      expect(manifest.runtimeVersion).toBe("1.2.3");
      expect(manifest.bundles["linux-x64"]?.url.startsWith("file://")).toBe(true);
      expect(manifest.bundles["linux-x64"]?.sha256).toBe(sha256(bytes));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("output manifest is consumable by the runtime-bundle downloader and verifies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-build-roundtrip-"));
    try {
      const bytes = new TextEncoder().encode("current-commit-runtime-bundle");
      await writeFile(join(dir, "lando-runtime-linux-x64.tar.gz"), bytes);

      const manifest = await buildRuntimeBundleManifest({
        stagingDir: dir,
        runtimeVersion: "9.9.9-local",
        targets: [{ key: "linux-x64", filename: "lando-runtime-linux-x64.tar.gz" }],
        urlFor: (_target, artifactPath) => fileUrl(artifactPath),
      });
      const manifestPath = join(dir, "runtime-bundle-versions.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const stateDir = join(dir, "state");
      const artifactDownload = await Effect.runPromise(coreArtifactDownload);
      const bundle = await Effect.runPromise(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          manifestPath,
          artifactDownload,
        }).download,
      );

      expect(bundle.bytes).toEqual(bytes);
      expect(bundle.sha256).toBe(sha256(bytes));
      expect(bundle.version).toBe("9.9.9-local");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("release-mode URL derivation", () => {
  test("resolveRuntimeBundleRepository honors GITHUB_REPOSITORY, else the in-repo default", () => {
    expect(resolveRuntimeBundleRepository({ GITHUB_REPOSITORY: "octo/app" })).toBe("octo/app");
    expect(resolveRuntimeBundleRepository({ GITHUB_REPOSITORY: "" })).toBe(
      LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT,
    );
    expect(resolveRuntimeBundleRepository({})).toBe(LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT);
    expect(LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT).toBe("lando-community/core4");
  });

  test("releaseBundleBaseUrl points at this repository's runtime-v<version> release path", () => {
    expect(releaseBundleBaseUrl("0.1.0", "lando-community/core4")).toBe(
      "https://github.com/lando-community/core4/releases/download/runtime-v0.1.0",
    );
  });

  test("releaseBundleUrl derives the in-repo asset URL when no base URL override is given", () => {
    const target = { key: "linux-x64", filename: "lando-runtime-linux-x64.tar.gz" };
    expect(releaseBundleUrl(target, { runtimeVersion: "0.1.0", repository: "lando-community/core4" })).toBe(
      "https://github.com/lando-community/core4/releases/download/runtime-v0.1.0/lando-runtime-linux-x64.tar.gz",
    );
  });

  test("releaseBundleUrl honors an explicit base URL override and trims trailing slashes", () => {
    const target = { key: "win32-x64", filename: "lando-runtime-win32-x64.zip" };
    expect(
      releaseBundleUrl(target, {
        runtimeVersion: "0.1.0",
        repository: "lando-community/core4",
        baseUrl: "https://example.test/bundles///",
      }),
    ).toBe("https://example.test/bundles/lando-runtime-win32-x64.zip");
  });

  test("derived URLs are HTTPS for every runtime host target", () => {
    for (const target of RUNTIME_BUNDLE_TARGETS) {
      const url = releaseBundleUrl(target, {
        runtimeVersion: "1.2.3",
        repository: "lando-community/core4",
      });
      expect(
        url.startsWith("https://github.com/lando-community/core4/releases/download/runtime-v1.2.3/"),
      ).toBe(true);
      expect(url.endsWith(target.filename)).toBe(true);
    }
  });
});
