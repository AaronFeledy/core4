import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { sha256Hex } from "@lando/sdk/digest";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { Effect } from "effect";

import {
  isUsableManagedCatatonit,
  readInstalledRuntimeVersion,
  verifyManagedCatatonitIdentity,
  verifyManagedCatatonitNotices,
  writeBridgeIdentity,
  writeBridgeNotices,
} from "./catatonit-installation.ts";
import { DebianArchiveError, extractCatatonit, verifyStaticCatatonit } from "./catatonit-payload.ts";
import {
  CATATONIT_MANIFEST,
  type CatatonitPackage,
  LEGACY_NATIVE_INIT_BRIDGE_VERSION,
  managedCatatonitPath,
  runtimeRecipeIncludesNativeInitHelper,
} from "./catatonit-pins.ts";
import type { ArtifactDownload } from "./runtime-bundle.ts";

export {
  CATATONIT_IDENTITY_RECEIPT,
  CATATONIT_MANIFEST,
  LEGACY_NATIVE_INIT_BRIDGE_VERSION,
  RUNTIME_INSTALLED_VERSION_MARKER,
  type CatatonitPackage,
  buildCatatonitIdentity,
  catatonitPackageForArch,
  managedCatatonitIdentityPath,
  managedCatatonitNoticesDir,
  managedCatatonitPath,
  runtimeInstalledVersionPath,
  runtimeRecipeIncludesNativeInitHelper,
  serializeCatatonitIdentity,
} from "./catatonit-pins.ts";
export { DebianArchiveError, extractCatatonit, verifyStaticCatatonit } from "./catatonit-payload.ts";
export {
  isUsableManagedCatatonit,
  readInstalledRuntimeVersion,
  verifyManagedCatatonitIdentity,
  verifyManagedCatatonitNotices,
} from "./catatonit-installation.ts";

const provisionError = (message: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message,
    remediation:
      "Run `lando setup` to repair the verified native init helper in the Lando managed runtime, then retry.",
    ...(cause === undefined ? {} : { cause }),
  });

const downloadLicenseFiles = Effect.fn("ProviderLando.downloadNativeInitLicenses")(function* (
  pkg: CatatonitPackage,
  download: ArtifactDownload,
  cacheDir: string,
): Effect.fn.Return<
  ReadonlyArray<{ readonly file: string; readonly bytes: Uint8Array }>,
  ProviderUnavailableError
> {
  const licenseFiles: Array<{ readonly file: string; readonly bytes: Uint8Array }> = [];
  for (const text of pkg.license.texts) {
    const licenseArtifact = yield* download({
      url: text.url,
      expectedSha256: text.sha256,
      directory: cacheDir,
      filename: `catatonit-license-${text.file}`,
      allowFileSource: false,
    });
    if (sha256Hex(licenseArtifact.bytes) !== text.sha256) {
      return yield* Effect.fail(provisionError("Catatonit license text digest does not match its pin."));
    }
    licenseFiles.push({ file: text.file, bytes: licenseArtifact.bytes });
  }
  return licenseFiles;
});

export interface EnsureManagedCatatonitOptions {
  readonly runtimeBinDir: string;
  readonly cacheDir: string;
  readonly download: ArtifactDownload;
  readonly arch?: string;
  readonly package?: CatatonitPackage;
}

interface PreparedState {
  readonly installedVersion: string;
  readonly helperReady: boolean;
  readonly noticesReady: boolean;
  readonly complete: boolean;
}

const assessPreparedState = async (
  runtimeBinDir: string,
  path: string,
  pkg: CatatonitPackage,
  installedVersion: string,
): Promise<PreparedState> => {
  const helperReady = await isUsableManagedCatatonit(path, pkg);
  if (installedVersion === LEGACY_NATIVE_INIT_BRIDGE_VERSION) {
    const noticesReady = await verifyManagedCatatonitNotices(runtimeBinDir, pkg, {
      requireBridgeNoticesMd: true,
    });
    const identityReady = await verifyManagedCatatonitIdentity(runtimeBinDir, pkg);
    return {
      installedVersion,
      helperReady,
      noticesReady,
      complete: helperReady && noticesReady && identityReady,
    };
  }
  if (runtimeRecipeIncludesNativeInitHelper(installedVersion)) {
    const noticesReady = await verifyManagedCatatonitNotices(runtimeBinDir, pkg);
    return {
      installedVersion,
      helperReady,
      noticesReady,
      complete: helperReady && noticesReady,
    };
  }
  return {
    installedVersion,
    helperReady,
    noticesReady: false,
    complete: false,
  };
};

export const ensureManagedCatatonit = Effect.fn("ProviderLando.ensureManagedCatatonit")(function* (
  options: EnsureManagedCatatonitOptions,
): Effect.fn.Return<void, ProviderUnavailableError> {
  const arch = options.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64")
    return yield* Effect.fail(provisionError(`No pinned static catatonit for ${arch}.`));
  const pkg = options.package ?? CATATONIT_MANIFEST.packages[arch];
  if (pkg.elfMachine !== (arch === "x64" ? 62 : 183)) {
    return yield* Effect.fail(provisionError(`Pinned catatonit architecture does not match ${arch}.`));
  }
  const path = managedCatatonitPath(options.runtimeBinDir);

  const prepared = yield* Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(options.runtimeBinDir))
        throw new DebianArchiveError("Managed catatonit requires an absolute runtime bin directory.");
      await mkdir(options.runtimeBinDir, { recursive: true, mode: 0o700 });
      const info = await lstat(options.runtimeBinDir);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid !== undefined && info.uid !== process.getuid())
      ) {
        throw new DebianArchiveError(
          "Managed runtime bin directory must be owner-controlled and not symlinked.",
        );
      }
      if ((info.mode & 0o022) !== 0) await chmod(options.runtimeBinDir, info.mode & 0o755);
      // Caller holds the parent launch/setup lock; re-read the on-disk marker here.
      const installedVersion = await readInstalledRuntimeVersion(options.runtimeBinDir);
      if (installedVersion === undefined) {
        throw provisionError(
          "Managed runtime installation marker is missing; native init cannot guess a helper source.",
        );
      }
      return await assessPreparedState(options.runtimeBinDir, path, pkg, installedVersion);
    },
    catch: (cause) =>
      cause instanceof ProviderUnavailableError
        ? cause
        : provisionError("Cannot verify the managed native init installation.", cause),
  });

  if (prepared.complete) return;

  if (prepared.installedVersion !== LEGACY_NATIVE_INIT_BRIDGE_VERSION) {
    return yield* Effect.fail(
      provisionError(
        prepared.installedVersion === CATATONIT_MANIFEST.recipeRuntimeVersion
          ? prepared.helperReady
            ? `The helper-bearing runtime ${prepared.installedVersion} is missing verified native init license notices; Debian fallback is not allowed.`
            : `The helper-bearing runtime ${prepared.installedVersion} is missing a verified native init helper; Debian fallback is not allowed.`
          : `Managed runtime version "${prepared.installedVersion}" is not eligible for the native init compatibility bridge.`,
      ),
    );
  }

  // Bridge path: reuse a verified helper and only fetch the Deb when the binary itself is unusable.
  let helperBytes: Uint8Array | undefined;
  if (!prepared.helperReady) {
    const artifact = yield* options.download({
      url: pkg.url,
      expectedSha256: pkg.sha256,
      expectedSizeBytes: pkg.sizeBytes,
      directory: options.cacheDir,
      filename: pkg.filename,
      allowFileSource: false,
    });
    helperBytes = yield* Effect.tryPromise({
      try: async (signal) => {
        if (artifact.bytes.length !== pkg.sizeBytes || sha256Hex(artifact.bytes) !== pkg.sha256)
          throw new DebianArchiveError("Catatonit Debian package digest or size does not match its pin.");
        const bytes = await extractCatatonit(artifact.bytes, pkg, signal);
        verifyStaticCatatonit(bytes, pkg);
        return bytes;
      },
      catch: (cause) => provisionError("Failed to provision the verified static native init helper.", cause),
    });
  }

  // License network only when notices themselves are incomplete; identity-only gaps skip downloads.
  const licenseFiles = !prepared.noticesReady
    ? yield* downloadLicenseFiles(pkg, options.download, options.cacheDir)
    : undefined;

  yield* Effect.tryPromise({
    try: async (signal) => {
      // Recheck under the parent lock before publishing any repair.
      const currentVersion = await readInstalledRuntimeVersion(options.runtimeBinDir);
      if (currentVersion !== LEGACY_NATIVE_INIT_BRIDGE_VERSION) {
        throw provisionError(
          currentVersion === undefined
            ? "Managed runtime installation marker is missing; native init cannot guess a helper source."
            : `Managed runtime version "${currentVersion}" is not eligible for the native init compatibility bridge.`,
        );
      }
      const recheck = await assessPreparedState(options.runtimeBinDir, path, pkg, currentVersion);
      if (recheck.complete) return;

      signal.throwIfAborted();
      if (!recheck.helperReady) {
        if (helperBytes === undefined) {
          throw provisionError("Native init helper became unusable before bridge publication.");
        }
        await writeFileAtomic(path, helperBytes, { mode: 0o755, ownerOnly: "strict" });
      }

      if (!recheck.noticesReady) {
        if (licenseFiles === undefined) {
          throw provisionError("Native init bridge notices became incomplete before publication.");
        }
        await writeBridgeNotices(options.runtimeBinDir, pkg, licenseFiles);
      }

      // Identity receipt is the completion boundary; write it last.
      await writeBridgeIdentity(options.runtimeBinDir, pkg);
    },
    catch: (cause) =>
      cause instanceof ProviderUnavailableError
        ? cause
        : provisionError("Failed to provision the verified static native init helper.", cause),
  });
});
