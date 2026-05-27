import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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
        "The Lando runtime bundle did not match the pinned SHA-256 from the bundled checksum manifest (spec §5.8.1). Retry `lando setup`; if it fails again, report the release artifact URL and the observed checksum.",
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
      "Run `lando setup` on a supported host (Linux x64/arm64, macOS x64/arm64, Windows x64) or update the bundled manifest (spec §5.8.1).",
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
                "Run `lando setup` on a supported host (Linux x64/arm64, macOS x64/arm64, Windows x64) or update the bundled manifest (spec §5.8.1).",
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
      remediation: "Use a basename-only runtime-bundle filename from the pinned manifest (spec §5.8.1).",
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
      remediation: "Use a basename-only runtime-bundle filename from the pinned manifest (spec §5.8.1).",
    });
  }

  return cachePath;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const currentArch = (): string => process.arch;

const readCachedBundle = (cachePath: string): Promise<Uint8Array | undefined> =>
  readFile(cachePath).then(
    (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    () => undefined,
  );

export interface RuntimeBundleDownloaderOptions {
  readonly stateDir: string;
  readonly entry: RuntimeBundleEntry;
  readonly runtimeVersion: string;
  /** Injectable for tests. Defaults to `globalThis.fetch` (Bun built-in). */
  readonly fetchImpl?: typeof fetch;
}

export const makeRuntimeBundleDownloader = (
  options: RuntimeBundleDownloaderOptions,
): RuntimeBundleDownloader => {
  const entry = options.entry;
  const cachePath = runtimeBundleCachePath(options.stateDir, entry);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const runtimeVersion = options.runtimeVersion;

  const downloadEffect: Effect.Effect<RuntimeBundle, ProviderUnavailableError> = Effect.gen(function* () {
    const cached = yield* Effect.promise(() => readCachedBundle(cachePath));
    if (cached !== undefined && sha256Hex(cached) === entry.sha256) {
      return {
        version: runtimeVersion,
        bytes: cached,
        sha256: entry.sha256,
      } satisfies RuntimeBundle;
    }

    const fetched = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(entry.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText} while fetching ${entry.url}`);
        }
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
      },
      catch: (cause) =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "setup",
          message: `Failed to download the Lando runtime bundle from ${entry.url}.`,
          remediation:
            "Check network connectivity, proxy/CA configuration, and retry `lando setup` (spec §5.8.1).",
          cause,
        }),
    });

    const actual = sha256Hex(fetched);
    if (actual !== entry.sha256) {
      return yield* Effect.fail(
        new ProviderBundleChecksumError(
          `The downloaded Lando runtime bundle checksum did not match the pinned value for ${entry.filename}.`,
          { url: entry.url, expected: entry.sha256, actual },
        ),
      );
    }

    yield* Effect.tryPromise({
      try: async () => {
        const dir = dirname(cachePath);
        await mkdir(dir, { recursive: true });
        const tmpPath = join(dir, `.${entry.filename}.tmp-${process.pid}-${randomUUID()}`);
        try {
          await writeFile(tmpPath, fetched, { flag: "wx" });
          await rename(tmpPath, cachePath);
        } catch (cause) {
          await rm(tmpPath, { force: true });
          throw cause;
        }
      },
      catch: (cause) =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "setup",
          message: `Failed to persist the verified runtime bundle at ${cachePath}.`,
          remediation: `Check permissions for ${dirname(cachePath)} and rerun \`lando setup\`.`,
          cause,
        }),
    });

    return {
      version: runtimeVersion,
      bytes: fetched,
      sha256: entry.sha256,
    } satisfies RuntimeBundle;
  });

  return { download: downloadEffect };
};

export interface DefaultRuntimeBundleDownloaderOptions {
  readonly stateDir: string;
  readonly platform?: HostPlatform;
  readonly arch?: string;
  /** Injectable for tests. Defaults to `globalThis.fetch` (Bun built-in). */
  readonly fetchImpl?: typeof fetch;
}

export const makeDefaultRuntimeBundleDownloader = (
  options: DefaultRuntimeBundleDownloaderOptions,
): RuntimeBundleDownloader => {
  const arch = options.arch ?? currentArch();

  const downloadEffect: Effect.Effect<RuntimeBundle, ProviderUnavailableError> = Effect.gen(function* () {
    const platform = options.platform ?? currentHostPlatform();
    if (platform === undefined) {
      return yield* Effect.fail(unsupportedHostPlatformError());
    }
    const entry = yield* resolveRuntimeBundleEntry(platform, arch);
    const inner = makeRuntimeBundleDownloader({
      stateDir: options.stateDir,
      entry,
      runtimeVersion: RUNTIME_BUNDLE_MANIFEST.runtimeVersion,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return yield* inner.download;
  });

  return { download: downloadEffect };
};
