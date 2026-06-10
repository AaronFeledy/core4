import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit } from "effect";

import {
  ProviderBundleChecksumError,
  RUNTIME_BUNDLE_MANIFEST,
  RUNTIME_BUNDLE_MANIFEST_ENV,
  makeDefaultRuntimeBundleDownloader,
  resolveRuntimeBundleEntry,
  runtimeBundleCachePath,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";

import { type RuntimeBundleEntry, makeRuntimeBundleDownloader } from "../src/runtime-bundle.ts";

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

interface FetchCallLog {
  calls: number;
  urls: string[];
  init?: BunFetchRequestInit;
}

const fakeFetch = (
  responses: Map<string, { body: Uint8Array; status?: number }>,
  log: FetchCallLog,
): typeof fetch =>
  ((input: RequestInfo | URL, init?: BunFetchRequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    log.calls += 1;
    log.urls.push(url);
    log.init = init;
    const match = responses.get(url);
    if (match === undefined) {
      return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
    }
    const status = match.status ?? 200;
    return Promise.resolve(
      new Response(match.body, {
        status,
        statusText: status >= 400 ? "Error" : "OK",
      }),
    );
  }) as typeof fetch;

const throwingFetch: typeof fetch = (() => {
  throw new Error("network unreachable");
}) as typeof fetch;

const syntheticEntry = (filename: string, bytes: Uint8Array): RuntimeBundleEntry => ({
  url: `https://example.test/${filename}`,
  sha256: sha256(bytes),
  filename,
  sizeBytes: bytes.byteLength,
});

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
    const provider = failure as ProviderUnavailableError;
    expect(provider.message).toContain("win32-arm64");
    expect(provider.remediation).toContain("lando setup");
  });
});

describe("ProviderBundleChecksumError", () => {
  test("is a ProviderUnavailableError subtype", () => {
    const err = new ProviderBundleChecksumError("test");
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err).toBeInstanceOf(ProviderBundleChecksumError);
  });

  test("remediation cites section 5.8.1 and instructs the user to rerun `lando setup`", () => {
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

  test("strips a trailing slash on stateDir before joining", async () => {
    const entry = await Effect.runPromise(resolveRuntimeBundleEntry("linux", "x64"));
    expect(runtimeBundleCachePath("/var/lando/", entry)).toBe(
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

describe("makeRuntimeBundleDownloader (test seam: explicit entry)", () => {
  test("downloads, verifies, and persists the bundle on cache miss", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-download-"));
    try {
      const bytes = new TextEncoder().encode("lando-runtime-bundle-payload");
      const entry = syntheticEntry("synthetic-linux-x64.tar.gz", bytes);
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: fakeFetch(new Map([[entry.url, { body: bytes }]]), log),
      });

      const bundle = await Effect.runPromise(downloader.download);

      expect(bundle.version).toBe("9.9.9-test");
      expect(bundle.sha256).toBe(entry.sha256);
      expect(bundle.bytes).toEqual(bytes);
      expect(log.calls).toBe(1);
      expect(log.urls[0]).toBe(entry.url);

      const cachePath = runtimeBundleCachePath(stateDir, entry);
      const onDisk = await readFile(cachePath);
      expect(new Uint8Array(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength)).toEqual(bytes);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("passes resolved setup proxy and custom CA settings to Bun fetch", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-network-"));
    try {
      const bytes = new TextEncoder().encode("network-aware-bundle");
      const entry = syntheticEntry("synthetic-network.tar.gz", bytes);
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        network: {
          proxy: { https: "http://proxy.example:8080", noProxy: [] },
          ca: { trustHost: true, certs: ["/corp.pem"], loadedCerts: [{ pem: "CORP PEM" }] },
        },
        fetchImpl: fakeFetch(new Map([[entry.url, { body: bytes }]]), log),
      });

      await Effect.runPromise(downloader.download);

      expect(log.init).toMatchObject({ proxy: "http://proxy.example:8080", tls: { ca: ["CORP PEM"] } });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("is idempotent: a re-run with a valid cached bundle does not contact the network", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-idempotent-"));
    try {
      const bytes = new TextEncoder().encode("cached-and-valid-bundle");
      const entry = syntheticEntry("synthetic-darwin-arm64.tar.gz", bytes);
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: fakeFetch(new Map([[entry.url, { body: bytes }]]), log),
      });

      await Effect.runPromise(downloader.download);
      expect(log.calls).toBe(1);

      const second = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: throwingFetch,
      });
      const bundle = await Effect.runPromise(second.download);

      expect(bundle.bytes).toEqual(bytes);
      expect(bundle.sha256).toBe(entry.sha256);
      expect(log.calls).toBe(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("re-downloads when the cached bundle SHA does not match the pinned entry", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-stale-"));
    try {
      const validBytes = new TextEncoder().encode("the-real-bundle-bytes");
      const entry = syntheticEntry("synthetic-win32-x64.zip", validBytes);
      const cachePath = runtimeBundleCachePath(stateDir, entry);

      await mkdir(dirname(cachePath), { recursive: true });
      const stale = new TextEncoder().encode("STALE-cached-bytes");
      await writeFile(cachePath, stale);
      expect(sha256(stale)).not.toBe(entry.sha256);

      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: fakeFetch(new Map([[entry.url, { body: validBytes }]]), log),
      });

      const bundle = await Effect.runPromise(downloader.download);
      expect(bundle.bytes).toEqual(validBytes);
      expect(bundle.sha256).toBe(entry.sha256);
      expect(log.calls).toBe(1);

      const onDisk = await readFile(cachePath);
      expect(new Uint8Array(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength)).toEqual(validBytes);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("fails closed with ProviderBundleChecksumError when downloaded bytes do not match the pinned SHA", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-mismatch-"));
    try {
      const expectedBytes = new TextEncoder().encode("the-pinned-bundle");
      const entry = syntheticEntry("synthetic-linux-arm64.tar.gz", expectedBytes);
      const tampered = new TextEncoder().encode("tampered-bytes");
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: fakeFetch(new Map([[entry.url, { body: tampered }]]), log),
      });

      const exit = await Effect.runPromiseExit(downloader.download);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect(failure).toBeInstanceOf(ProviderBundleChecksumError);
      const checksum = failure as ProviderBundleChecksumError;
      expect(checksum.remediation).toContain("lando setup");
      expect(checksum.message).toContain(entry.filename);

      const cachePath = runtimeBundleCachePath(stateDir, entry);
      const onDisk = await readFile(cachePath).catch(() => undefined);
      expect(onDisk).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("surfaces a tagged ProviderUnavailableError on HTTP non-2xx", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-http-"));
    try {
      const entry = syntheticEntry("synthetic-darwin-x64.tar.gz", new TextEncoder().encode("anything"));
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: fakeFetch(new Map([[entry.url, { body: new Uint8Array(), status: 503 }]]), log),
      });

      const exit = await Effect.runPromiseExit(downloader.download);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect(failure).not.toBeInstanceOf(ProviderBundleChecksumError);
      const provider = failure as ProviderUnavailableError;
      expect(provider.message).toContain("download");
      expect(provider.remediation).toContain("lando setup");

      const cachePath = runtimeBundleCachePath(stateDir, entry);
      const onDisk = await readFile(cachePath).catch(() => undefined);
      expect(onDisk).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("surfaces a tagged ProviderUnavailableError when fetch itself throws", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-net-"));
    try {
      const entry = syntheticEntry("synthetic-linux-x64.tar.gz", new TextEncoder().encode("anything"));
      const downloader = makeRuntimeBundleDownloader({
        stateDir,
        entry,
        runtimeVersion: "9.9.9-test",
        fetchImpl: throwingFetch,
      });

      const exit = await Effect.runPromiseExit(downloader.download);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect(failure).not.toBeInstanceOf(ProviderBundleChecksumError);
      expect((failure as ProviderUnavailableError).remediation).toContain("lando setup");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("makeDefaultRuntimeBundleDownloader (routes through the shipped manifest)", () => {
  test("fails closed with ProviderBundleChecksumError when downloaded bytes do not match the pinned manifest SHA", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-default-"));
    try {
      const entry = await Effect.runPromise(resolveRuntimeBundleEntry("win32", "x64"));
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeDefaultRuntimeBundleDownloader({
        stateDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeFetch(
          new Map([[entry.url, { body: new TextEncoder().encode("tampered-windows-bundle") }]]),
          log,
        ),
      });

      const exit = await Effect.runPromiseExit(downloader.download);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderBundleChecksumError);
      expect((failure as ProviderBundleChecksumError).remediation).toContain("lando setup");
      expect(log.calls).toBe(1);
      expect(log.urls[0]).toBe(entry.url);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("rejects a URL override that is not paired with a SHA-256 override", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-default-url-"));
    try {
      const overrideUrl = "https://mirror.example.invalid/lando-runtime.zip";
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeDefaultRuntimeBundleDownloader({
        stateDir,
        platform: "win32",
        arch: "x64",
        url: overrideUrl,
        fetchImpl: fakeFetch(
          new Map([[overrideUrl, { body: new TextEncoder().encode("tampered-mirror-bundle") }]]),
          log,
        ),
      });

      const exit = await Effect.runPromiseExit(downloader.download);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect(failure).not.toBeInstanceOf(ProviderBundleChecksumError);
      expect((failure as ProviderUnavailableError).message).toContain("must be supplied together");
      expect(log.calls).toBe(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("propagates the unsupported-platform error from the manifest resolver", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-runtime-bundle-default-unsupported-"));
    try {
      const log: FetchCallLog = { calls: 0, urls: [] };
      const downloader = makeDefaultRuntimeBundleDownloader({
        stateDir,
        platform: "win32",
        arch: "arm64",
        fetchImpl: fakeFetch(new Map(), log),
      });

      const exit = await Effect.runPromiseExit(downloader.download);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).message).toContain("win32-arm64");
      expect(log.calls).toBe(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

const localManifest = (
  entry: RuntimeBundleEntry,
  platformKey = "linux-x64",
  runtimeVersion = "9.9.9-local",
): string => JSON.stringify({ schemaVersion: 1, runtimeVersion, bundles: { [platformKey]: entry } });

const stageLocalBundle = async (dir: string, filename: string, bytes: Uint8Array): Promise<string> => {
  const bundlePath = join(dir, filename);
  await writeFile(bundlePath, bytes);
  return pathToFileURL(bundlePath).href;
};

describe("makeDefaultRuntimeBundleDownloader (local bundle override)", () => {
  test("LANDO_RUNTIME_BUNDLE_MANIFEST redirects to a file:// bundle and verifies its SHA", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-"));
    try {
      const bytes = new TextEncoder().encode("locally-built-bundle");
      const url = await stageLocalBundle(stateDir, "local-linux-x64.tar.gz", bytes);
      const entry: RuntimeBundleEntry = {
        url,
        sha256: sha256(bytes),
        filename: "local-linux-x64.tar.gz",
        sizeBytes: bytes.byteLength,
      };
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, localManifest(entry));

      const bundle = await Effect.runPromise(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          env: { [RUNTIME_BUNDLE_MANIFEST_ENV]: manifestPath },
          fetchImpl: throwingFetch,
        }).download,
      );

      expect(bundle.bytes).toEqual(bytes);
      expect(bundle.sha256).toBe(entry.sha256);
      expect(bundle.version).toBe("9.9.9-local");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a file:// bundle whose bytes do not match the override SHA fails closed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-mismatch-"));
    try {
      const bytes = new TextEncoder().encode("locally-built-bundle");
      const url = await stageLocalBundle(stateDir, "local-linux-x64.tar.gz", bytes);
      const entry: RuntimeBundleEntry = {
        url,
        sha256: sha256(new TextEncoder().encode("different")),
        filename: "local-linux-x64.tar.gz",
        sizeBytes: bytes.byteLength,
      };
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, localManifest(entry));

      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({ stateDir, platform: "linux", arch: "x64", manifestPath })
          .download,
      );
      expect(expectFailure(exit)).toBeInstanceOf(ProviderBundleChecksumError);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("an override manifest with no entry for the host platform fails closed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-missing-"));
    try {
      const bytes = new TextEncoder().encode("x");
      const url = await stageLocalBundle(stateDir, "local.tar.gz", bytes);
      const entry: RuntimeBundleEntry = {
        url,
        sha256: sha256(bytes),
        filename: "local.tar.gz",
        sizeBytes: bytes.byteLength,
      };
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, localManifest(entry, "darwin-arm64"));

      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({ stateDir, platform: "linux", arch: "x64", manifestPath })
          .download,
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).message).toContain("linux-x64");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("an invalid override manifest fails closed with remediation citing the env var", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-env-invalid-"));
    try {
      const manifestPath = join(stateDir, "manifest.json");
      await writeFile(manifestPath, "{ not json");
      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({ stateDir, platform: "linux", arch: "x64", manifestPath })
          .download,
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).remediation).toContain(RUNTIME_BUNDLE_MANIFEST_ENV);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a URL override without a paired SHA-256 is rejected before any download", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-unpaired-"));
    try {
      const exit = await Effect.runPromiseExit(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          url: "https://example.test/x.tar.gz",
          fetchImpl: throwingFetch,
        }).download,
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).message).toContain("must be supplied together");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("paired URL + SHA-256 override a single entry and verify the bytes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-rb-paired-"));
    try {
      const bytes = new TextEncoder().encode("mirror-built-bundle");
      const url = await stageLocalBundle(stateDir, "mirror.tar.gz", bytes);
      const bundle = await Effect.runPromise(
        makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform: "linux",
          arch: "x64",
          url,
          sha256: sha256(bytes),
          fetchImpl: throwingFetch,
        }).download,
      );
      expect(bundle.bytes).toEqual(bytes);
      expect(bundle.sha256).toBe(sha256(bytes));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
