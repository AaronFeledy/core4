import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit } from "effect";

import {
  ProviderBundleChecksumError,
  RUNTIME_BUNDLE_MANIFEST,
  RUNTIME_BUNDLE_MANIFEST_ENV,
  makeDefaultRuntimeBundleDownloader,
  resolveRuntimeBundleEntry,
  runtimeBundleCachePath,
  setupProviderLando,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";

import {
  type ArtifactDownload,
  type RuntimeBundleEntry,
  makeRuntimeBundleDownloader,
} from "../src/runtime-bundle.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected effect to fail");
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error(`expected a tagged failure, got ${JSON.stringify(exit.cause)}`);
  }
  return failure.value;
};

type ArtifactDownloadRequest = Parameters<ArtifactDownload>[0];

const recordingArtifactDownload = (
  bytes: Uint8Array,
  options: { readonly sha256?: string; readonly fail?: ProviderUnavailableError } = {},
): { readonly artifactDownload: ArtifactDownload; readonly calls: ArtifactDownloadRequest[] } => {
  const calls: ArtifactDownloadRequest[] = [];
  const artifactDownload: ArtifactDownload = (request) =>
    Effect.sync(() => {
      calls.push(request);
    }).pipe(
      Effect.flatMap(() =>
        options.fail === undefined
          ? Effect.succeed({
              bytes,
              sha256: options.sha256 ?? request.expectedSha256,
              path: join(request.directory, request.filename),
            })
          : Effect.fail(options.fail),
      ),
    );
  return { artifactDownload, calls };
};

const syntheticEntry = (filename: string, bytes: Uint8Array): RuntimeBundleEntry => ({
  url: `https://example.test/${filename}`,
  sha256: sha256(bytes),
  filename,
  sizeBytes: bytes.byteLength,
});

const localManifest = (
  entry: RuntimeBundleEntry,
  platformKey = "linux-x64",
  runtimeVersion = "9.9.9-local",
): string => JSON.stringify({ schemaVersion: 1, runtimeVersion, bundles: { [platformKey]: entry } });

const allTsFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return allTsFiles(path);
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
};

describe("RUNTIME_BUNDLE_MANIFEST", () => {
  test("declares pinned entries for every supported platform/arch", () => {
    const keys = Object.keys(RUNTIME_BUNDLE_MANIFEST.bundles).sort();
    expect(keys).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  });

  test("every entry carries a 64-char hex SHA-256, a non-empty filename, and an https URL", () => {
    for (const [key, entry] of Object.entries(RUNTIME_BUNDLE_MANIFEST.bundles)) {
      expect(entry.sha256, `${key} sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.filename.length, `${key} filename`).toBeGreaterThan(0);
      expect(entry.url, `${key} url`).toMatch(/^https:\/\//);
    }
  });

  test("schema version + runtime version are populated", () => {
    expect(RUNTIME_BUNDLE_MANIFEST.schemaVersion).toBe(1);
    expect(RUNTIME_BUNDLE_MANIFEST.runtimeVersion.length).toBeGreaterThan(0);
  });
});

describe("resolveRuntimeBundleEntry", () => {
  test("returns the pinned entry for win32 x64", async () => {
    const entry = await Effect.runPromise(resolveRuntimeBundleEntry("win32", "x64"));
    expect(entry.url).toContain("win32-x64");
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns the pinned entry for linux x64", async () => {
    const entry = await Effect.runPromise(resolveRuntimeBundleEntry("linux", "x64"));
    expect(entry.url).toContain("linux-x64");
  });

  test("returns the pinned entry for darwin arm64", async () => {
    const entry = await Effect.runPromise(resolveRuntimeBundleEntry("darwin", "arm64"));
    expect(entry.url).toContain("darwin-arm64");
  });

  test("fails closed with actionable remediation for an unsupported platform/arch", async () => {
    const exit = await Effect.runPromiseExit(resolveRuntimeBundleEntry("win32", "arm64"));
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as ProviderUnavailableError).message).toContain("win32-arm64");
    expect((failure as ProviderUnavailableError).remediation).toContain("lando setup");
  });
});

describe("ProviderBundleChecksumError", () => {
  test("is a ProviderUnavailableError subtype", () => {
    const err = new ProviderBundleChecksumError("test");
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err).toBeInstanceOf(ProviderBundleChecksumError);
  });

  test("remediation instructs the user to rerun `lando setup`", () => {
    const err = new ProviderBundleChecksumError("test");
    expect(err.remediation).toContain("lando setup");
    expect(err.remediation).toContain("`lando setup`");
  });

  test("preserves the original cause", () => {
    const cause = { expected: "aa", actual: "bb" };
    const err = new ProviderBundleChecksumError("mismatch", cause);
    expect(err.cause).toEqual(cause);
  });
});

describe("runtimeBundleCachePath", () => {
  test("stores the bundle under <stateDir>/provider-lando/runtime-bundle/<filename>", async () => {
    const entry = await Effect.runPromise(resolveRuntimeBundleEntry("linux", "x64"));
    expect(runtimeBundleCachePath("/var/lando", entry)).toBe(
      `/var/lando/provider-lando/runtime-bundle/${entry.filename}`,
    );
  });

  test("rejects filenames that could escape the bundle cache directory", () => {
    const bytes = new TextEncoder().encode("safe bytes");
    for (const filename of ["../escape.zip", "nested/escape.zip", "nested\\escape.zip", ".", ".."] as const) {
      const entry = syntheticEntry(filename, bytes);
      try {
        runtimeBundleCachePath("/var/lando", entry);
        throw new Error(`expected ${filename} to be rejected`);
      } catch (cause) {
        expect(cause).toBeInstanceOf(ProviderUnavailableError);
      }
    }
  });
});

describe("makeRuntimeBundleDownloader", () => {
  test("delegates acquisition to the injected artifactDownload seam", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-artifact-"));
    try {
      const bytes = new TextEncoder().encode("runtime bundle bytes");
      const entry = syntheticEntry("synthetic-linux-x64.tar.gz", bytes);
      const { artifactDownload, calls } = recordingArtifactDownload(bytes);

      const bundle = await Effect.runPromise(
        makeRuntimeBundleDownloader({
          stateDir,
          entry,
          runtimeVersion: "9.9.9-test",
          artifactDownload,
        }).download,
      );

      const expectedPath = runtimeBundleCachePath(stateDir, entry);
      expect(bundle).toEqual({ version: "9.9.9-test", bytes, sha256: entry.sha256 });
      expect(calls).toEqual([
        {
          url: entry.url,
          expectedSha256: entry.sha256,
          expectedSizeBytes: entry.sizeBytes,
          directory: expectedPath.slice(0, -`/${entry.filename}`.length),
          filename: entry.filename,
          allowFileSource: false,
        },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("propagates ProviderUnavailableError failures from artifactDownload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-artifact-fail-"));
    try {
      const bytes = new TextEncoder().encode("runtime bundle bytes");
      const entry = syntheticEntry("synthetic-linux-x64.tar.gz", bytes);
      const expected = new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "artifact downloader rejected the request",
      });
      const { artifactDownload } = recordingArtifactDownload(bytes, { fail: expected });

      const exit = await Effect.runPromiseExit(
        makeRuntimeBundleDownloader({ stateDir, entry, runtimeVersion: "9.9.9-test", artifactDownload })
          .download,
      );

      expect(expectFailure(exit)).toBe(expected);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("makeDefaultRuntimeBundleDownloader", () => {
  test("env manifest plus paired URL/SHA override passes the final entry to artifactDownload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-paired-"));
    try {
      const manifestBytes = new TextEncoder().encode("manifest bytes");
      const manifestEntry = syntheticEntry("manifest-linux-x64.tar.gz", manifestBytes);
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, localManifest(manifestEntry, "linux-x64", "9.9.9-env"));

      const overrideBytes = new TextEncoder().encode("mirror bytes");
      const overrideSha = sha256(overrideBytes);
      const overrideUrl = "https://mirror.example.invalid/lando-runtime.tar.gz";
      const { artifactDownload, calls } = recordingArtifactDownload(overrideBytes);

      const bundle = await Effect.runPromise(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          env: { [RUNTIME_BUNDLE_MANIFEST_ENV]: manifestPath },
          url: overrideUrl,
          sha256: overrideSha,
          artifactDownload,
        }).download,
      );

      expect(bundle.version).toBe("9.9.9-env");
      expect(bundle.bytes).toEqual(overrideBytes);
      expect(bundle.sha256).toBe(overrideSha);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: overrideUrl,
        expectedSha256: overrideSha,
        expectedSizeBytes: manifestEntry.sizeBytes,
        filename: manifestEntry.filename,
        allowFileSource: false,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("file:// overrides set allowFileSource true on the artifactDownload request", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-file-"));
    try {
      const bytes = new TextEncoder().encode("local override bytes");
      const fileUrl = pathToFileURL(join(stateDir, "local-runtime.tar.gz")).href;
      const { artifactDownload, calls } = recordingArtifactDownload(bytes);

      await Effect.runPromise(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          url: fileUrl,
          sha256: sha256(bytes),
          artifactDownload,
        }).download,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(fileUrl);
      expect(calls[0]?.allowFileSource).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("rejects a URL override that is not paired with a SHA-256 override before artifactDownload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-unpaired-"));
    try {
      const { artifactDownload, calls } = recordingArtifactDownload(new TextEncoder().encode("unused"));
      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          url: "https://example.test/x.tar.gz",
          artifactDownload,
        }).download,
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).message).toContain("must be supplied together");
      expect(calls).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("an override manifest with no entry for the host platform fails closed before artifactDownload", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-missing-"));
    try {
      const bytes = new TextEncoder().encode("x");
      const entry = syntheticEntry("local.tar.gz", bytes);
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, localManifest(entry, "darwin-arm64"));
      const { artifactDownload, calls } = recordingArtifactDownload(bytes);

      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          manifestPath,
          artifactDownload,
        }).download,
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).message).toContain("linux-x64");
      expect(calls).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("an invalid override manifest fails closed with remediation citing the env var", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-invalid-"));
    try {
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, "{ not json");
      const { artifactDownload } = recordingArtifactDownload(new TextEncoder().encode("unused"));
      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          manifestPath,
          artifactDownload,
        }).download,
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).remediation).toContain(RUNTIME_BUNDLE_MANIFEST_ENV);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("runtime bundle verification", () => {
  test("setupProviderLando keeps the post-download SHA gate after artifactDownload returns", async () => {
    const expectedBytes = new TextEncoder().encode("expected runtime bundle");
    const tamperedBytes = new TextEncoder().encode("tampered runtime bundle");
    const entry = syntheticEntry("synthetic-linux-x64.tar.gz", expectedBytes);
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-post-verify-"));
    try {
      const { artifactDownload } = recordingArtifactDownload(tamperedBytes, { sha256: entry.sha256 });
      const runtimeBundleDownloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        artifactDownload,
      });
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "linux",
          podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
          podmanCommand: { version: Effect.succeed("podman version 5.2.0") },
          runtimeBundleDownloader,
        }),
      );

      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderBundleChecksumError);
      expect((failure as ProviderBundleChecksumError).remediation).toContain("checksum");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("runtime bundle source boundary", () => {
  test("provider runtime-bundle acquisition does not contain bespoke fetch code", async () => {
    const srcRoot = join(import.meta.dir, "../src");
    const offenders: string[] = [];
    for (const file of await allTsFiles(srcRoot)) {
      const text = await readFile(file, "utf8");
      if (/fetchInitForNetwork/u.test(text) || /\bfetch\s*\(/u.test(text)) {
        offenders.push(relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
