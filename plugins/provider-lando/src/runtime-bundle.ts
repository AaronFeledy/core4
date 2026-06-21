import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { Effect, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";

import manifestData from "../runtime-bundle-versions.json" with { type: "json" };

import type { RuntimeBundle, RuntimeBundleDownloader } from "./setup.ts";

const PROVIDER_ID = "lando";

export class ProviderBundleChecksumError extends ProviderUnavailableError {
  constructor(message: string, cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message,
      remediation:
        "The Lando runtime bundle did not match the pinned SHA-256 from the bundled checksum manifest. Retry `lando setup`; if it fails again, report the release artifact URL and the observed checksum.",
      cause,
    });
  }
}

const RuntimeBundleEntrySchema = Schema.Struct({
  url: Schema.String.pipe(Schema.pattern(/^https:\/\//u)),
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  filename: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  sizeBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});

const RuntimeBundleManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: Schema.String.pipe(Schema.minLength(1)),
  bundles: Schema.Record({ key: Schema.String, value: RuntimeBundleEntrySchema }),
});

export type RuntimeBundleEntry = Schema.Schema.Type<typeof RuntimeBundleEntrySchema>;
export type RuntimeBundleManifest = Schema.Schema.Type<typeof RuntimeBundleManifestSchema>;

export const RUNTIME_BUNDLE_MANIFEST: RuntimeBundleManifest =
  Schema.decodeUnknownSync(RuntimeBundleManifestSchema)(manifestData);

/**
 * Env var that redirects `lando setup` to a locally-built runtime bundle.
 *
 * Points at an alternate manifest (identical shape to the bundled one, but
 * `file://` URLs are permitted). Verification stays enforced against each
 * entry's pinned SHA-256 — the override redirects verification, it never
 * disables it.
 */
export const RUNTIME_BUNDLE_MANIFEST_ENV = "LANDO_RUNTIME_BUNDLE_MANIFEST";

const OverrideRuntimeBundleEntrySchema = Schema.Struct({
  url: Schema.String.pipe(Schema.pattern(/^(?:https|file):\/\//u)),
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  filename: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  sizeBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});

const OverrideRuntimeBundleManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: Schema.String.pipe(Schema.minLength(1)),
  bundles: Schema.Record({ key: Schema.String, value: OverrideRuntimeBundleEntrySchema }),
});

export type OverrideRuntimeBundleManifest = Schema.Schema.Type<typeof OverrideRuntimeBundleManifestSchema>;

const overrideManifestError = (path: string, detail: string, cause?: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message: `Runtime-bundle override manifest at ${path} ${detail}.`,
    remediation: `Point ${RUNTIME_BUNDLE_MANIFEST_ENV} at a valid runtime-bundle manifest (schemaVersion 1, per-platform { url, sha256, filename, sizeBytes }), or unset it to use the bundled pinned manifest.`,
    ...(cause === undefined ? {} : { cause }),
  });

const loadOverrideManifest = (
  path: string,
): Effect.Effect<OverrideRuntimeBundleManifest, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => overrideManifestError(path, "could not be read", cause),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) => overrideManifestError(path, "is not valid JSON", cause),
      }),
    ),
    Effect.flatMap((data) =>
      Schema.decodeUnknown(OverrideRuntimeBundleManifestSchema)(data).pipe(
        Effect.mapError((cause) => overrideManifestError(path, "failed schema validation", cause)),
      ),
    ),
  );

const platformArchKey = (platform: HostPlatform, arch: string): string => `${platform}-${arch}`;

const currentHostPlatform = (): HostPlatform | undefined => {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") {
    return process.platform;
  }
  return undefined;
};

const unsupportedHostPlatformError = () =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message: `No pinned runtime-bundle entry for unsupported host platform ${process.platform}.`,
    remediation:
      "Run `lando setup` on a supported host (Linux x64/arm64, macOS x64/arm64, Windows x64) or update the bundled manifest.",
  });

/**
 * Resolve the pinned manifest entry for a given host platform + arch.
 *
 * Fails closed with {@link ProviderUnavailableError} when the combination is
 * not represented in the manifest, so an unsupported host never silently
 * proceeds without a verifiable bundle.
 */
export const resolveRuntimeBundleEntry = (
  platform: HostPlatform,
  arch: string,
): Effect.Effect<RuntimeBundleEntry, ProviderUnavailableError> =>
  Effect.sync(() => RUNTIME_BUNDLE_MANIFEST.bundles[platformArchKey(platform, arch)]).pipe(
    Effect.flatMap((entry) =>
      entry === undefined
        ? Effect.fail(
            new ProviderUnavailableError({
              providerId: PROVIDER_ID,
              operation: "setup",
              message: `No pinned runtime-bundle entry for ${platformArchKey(platform, arch)}.`,
              remediation:
                "Run `lando setup` on a supported host (Linux x64/arm64, macOS x64/arm64, Windows x64) or update the bundled manifest.",
            }),
          )
        : Effect.succeed(entry),
    ),
  );

export const runtimeBundleCachePath = (stateDir: string, entry: RuntimeBundleEntry): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.filename)) {
    throw new ProviderUnavailableError({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: `Invalid runtime-bundle filename ${entry.filename}.`,
      remediation: "Use a basename-only runtime-bundle filename from the pinned manifest.",
    });
  }

  const baseDir = resolve(stateDir, "provider-lando", "runtime-bundle");
  const cachePath = resolve(baseDir, entry.filename);
  const relativePath = relative(baseDir, cachePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes("/../")) {
    throw new ProviderUnavailableError({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: `Runtime-bundle filename ${entry.filename} escapes the provider cache directory.`,
      remediation: "Use a basename-only runtime-bundle filename from the pinned manifest.",
    });
  }

  return cachePath;
};

export interface ArtifactDownloadRequest {
  readonly url: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes?: number;
  readonly directory: string;
  readonly filename: string;
  readonly allowFileSource: boolean;
}

export interface ArtifactDownloadResult {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly path: string;
}

export type ArtifactDownload = (
  req: ArtifactDownloadRequest,
) => Effect.Effect<ArtifactDownloadResult, ProviderUnavailableError>;

export interface RuntimeBundleDownloaderOptions {
  readonly stateDir: string;
  readonly entry: RuntimeBundleEntry;
  readonly runtimeVersion: string;
  readonly artifactDownload: ArtifactDownload;
  readonly skipSizeCheck?: boolean;
}

export const makeRuntimeBundleDownloader = (
  options: RuntimeBundleDownloaderOptions,
): RuntimeBundleDownloader => {
  const entry = options.entry;
  const cachePath = runtimeBundleCachePath(options.stateDir, entry);
  const runtimeVersion = options.runtimeVersion;

  const downloadEffect: Effect.Effect<RuntimeBundle, ProviderUnavailableError> = Effect.gen(function* () {
    const artifact = yield* options.artifactDownload({
      url: entry.url,
      expectedSha256: entry.sha256,
      ...(options.skipSizeCheck === true ? {} : { expectedSizeBytes: entry.sizeBytes }),
      directory: dirname(cachePath),
      filename: entry.filename,
      allowFileSource: entry.url.startsWith("file://"),
    });

    return {
      version: runtimeVersion,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    } satisfies RuntimeBundle;
  });

  return { download: downloadEffect };
};

const currentArch = (): string => process.arch;

export interface DefaultRuntimeBundleDownloaderOptions {
  readonly stateDir: string;
  readonly platform?: HostPlatform;
  readonly arch?: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly manifestPath?: string;
  /** Injectable for tests. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  readonly artifactDownload: ArtifactDownload;
}

const pairedOverrideError = (): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message: "Runtime-bundle URL and SHA-256 overrides must be supplied together.",
    remediation:
      "Pass both --runtime-bundle-url and --runtime-bundle-sha256 (a URL swap that keeps the pinned checksum can never verify a different artifact), or neither.",
  });

const overrideEntryMissingError = (
  platform: HostPlatform,
  arch: string,
  manifestPath: string,
): ProviderUnavailableError =>
  overrideManifestError(manifestPath, `has no entry for ${platformArchKey(platform, arch)}`);

export const makeDefaultRuntimeBundleDownloader = (
  options: DefaultRuntimeBundleDownloaderOptions,
): RuntimeBundleDownloader => {
  const arch = options.arch ?? currentArch();

  const downloadEffect: Effect.Effect<RuntimeBundle, ProviderUnavailableError> = Effect.gen(function* () {
    const platform = options.platform ?? currentHostPlatform();
    if (platform === undefined) {
      return yield* Effect.fail(unsupportedHostPlatformError());
    }
    if ((options.url === undefined) !== (options.sha256 === undefined)) {
      return yield* Effect.fail(pairedOverrideError());
    }

    const env = options.env ?? process.env;
    const manifestPath = options.manifestPath ?? env[RUNTIME_BUNDLE_MANIFEST_ENV];

    let entry: RuntimeBundleEntry;
    let runtimeVersion = RUNTIME_BUNDLE_MANIFEST.runtimeVersion;
    if (typeof manifestPath === "string" && manifestPath.length > 0) {
      const manifest = yield* loadOverrideManifest(manifestPath);
      const resolved = manifest.bundles[platformArchKey(platform, arch)];
      if (resolved === undefined) {
        return yield* Effect.fail(overrideEntryMissingError(platform, arch, manifestPath));
      }
      entry = resolved;
      runtimeVersion = manifest.runtimeVersion;
    } else {
      entry = yield* resolveRuntimeBundleEntry(platform, arch);
    }

    const finalEntry =
      options.url === undefined
        ? entry
        : { ...entry, url: options.url, sha256: options.sha256 ?? entry.sha256 };
    const inner = makeRuntimeBundleDownloader({
      stateDir: options.stateDir,
      entry: finalEntry,
      runtimeVersion,
      artifactDownload: options.artifactDownload,
      skipSizeCheck: options.url !== undefined,
    });
    return yield* inner.download;
  });

  return { download: downloadEffect };
};
