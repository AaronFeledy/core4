/** Update orchestration, launch probing, and platform apply flows. */
import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import type { UpdateChannel, UpdateManifestSchema as UpdateManifest } from "@lando/sdk/schema";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { recordUpdateOutcomeTelemetry, updateOutcomeFromError } from "../telemetry/events";
import { scrubTelemetryValue } from "../telemetry/redaction";
import { CORE_VERSION } from "../version";
import {
  type UpdateError,
  UpdateLaunchProbeError,
  UpdateNetworkError,
  UpdatePermissionError,
} from "./errors.ts";
import {
  type UpdateManifestFetcher,
  compareVersions,
  decodeManifest,
  defaultFetchManifestBytes,
  enforceManifestFreshness,
  enforceMinimumVersion,
  enforceNoDowngrade,
  failureOutcomeFromError,
  fetchBytes,
  isPlaceholderBinary,
  parseJson,
  platform,
  readUpdateManifestState,
  resolveUpdateManifestUrl,
  updateChannelForVersion,
  updateManifestPlatform,
  updateManifestStatePath,
  updatePlatformId,
  writeUpdateFailureState,
  writeUpdateManifestState,
} from "./manifest.ts";
import {
  type ResolvedSelfUpdateOptions,
  type UpdateSelfUpdateOptions,
  cleanupUpdateTempDir,
  isPermissionCause,
  posixPermissionRemediation,
  reexecUserArgv,
  renameForUpdate,
  resolveSelfUpdateOptions,
  stringEnv,
  writeDownloadedBinary,
} from "./self-update.ts";
import {
  type UpdateChecksumSignatureVerifier,
  type UpdateManifestSignatureVerifier,
  artifactNameFromUrl,
  checksumCertificateUrlFor,
  defaultVerifyChecksumSignature,
  defaultVerifyManifestSignature,
  verifyBinaryChecksum,
  verifyChecksumSignature,
  verifyManifestSignature,
} from "./verify.ts";
import {
  type UpdateWindowsReplacementInput,
  windowsManualFallback,
  windowsPermissionRemediation,
} from "./windows.ts";

export interface UpdateOptions {
  readonly channel?: UpdateChannel;
  readonly dryRun?: boolean;
  readonly currentVersion?: string;
  readonly targetVersion?: string;
  readonly fetchManifestBytes?: UpdateManifestFetcher;
  readonly selfUpdate?: false | UpdateSelfUpdateOptions;
  readonly verifyManifestSignature?: UpdateManifestSignatureVerifier;
  readonly verifyChecksumSignature?: UpdateChecksumSignatureVerifier;
  readonly updateStatePath?: string;
  readonly runUpdate?: () => Effect.Effect<UpdateResult, UpdateError, never>;
}

export interface UpdateResult {
  readonly updatedCore: boolean;
  readonly updatedPlugins: ReadonlyArray<string>;
}

const probeCommandSummary = (path: string): string => `${scrubTelemetryValue(path)} --version`;

const probeOutputSummary = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly cause?: unknown;
}): string => {
  const parts: string[] = [];
  const stdout = input.stdout?.trim();
  if (stdout !== undefined && stdout.length > 0) parts.push(`stdout: ${stdout}`);
  const stderr = input.stderr?.trim();
  if (stderr !== undefined && stderr.length > 0) parts.push(`stderr: ${stderr}`);
  if (input.cause !== undefined) {
    const cause = input.cause instanceof Error ? input.cause.message : String(input.cause);
    if (cause.length > 0) parts.push(`cause: ${cause}`);
  }
  return scrubTelemetryValue(parts.join("\n")).slice(0, 500);
};

const launchProbeError = ({
  attemptedVersion,
  cause,
  exitCode,
  path,
  platformId,
  stderr,
  stdout,
}: {
  readonly path: string;
  readonly platformId: string;
  readonly attemptedVersion: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
  readonly cause?: unknown;
}): UpdateLaunchProbeError => {
  const outputInput: { stdout?: string; stderr?: string; cause?: unknown } = {};
  if (stdout !== undefined) outputInput.stdout = stdout;
  if (stderr !== undefined) outputInput.stderr = stderr;
  if (cause !== undefined) outputInput.cause = cause;
  return new UpdateLaunchProbeError({
    message: `Downloaded Lando ${attemptedVersion} failed its launch probe on ${platformId}.`,
    platform: platformId,
    attemptedVersion,
    probeCommand: probeCommandSummary(path),
    outputSummary: probeOutputSummary(outputInput),
    exitCode,
    cause,
  });
};

const withRollbackFailure = (error: UpdateLaunchProbeError, cause: unknown): UpdateLaunchProbeError =>
  new UpdateLaunchProbeError({
    message: error.message,
    platform: error.platform,
    attemptedVersion: error.attemptedVersion,
    probeCommand: error.probeCommand,
    outputSummary: error.outputSummary,
    exitCode: error.exitCode,
    rollbackFailure: scrubTelemetryValue(cause instanceof Error ? cause.message : String(cause)),
    cause: error.cause,
  });

const runLaunchProbe = (
  path: string,
  attemptedVersion: string,
  platformId: string,
): Effect.Effect<void, UpdateLaunchProbeError, ProcessRunner> =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const result = yield* processRunner
      .run({ cmd: path, args: ["--version"], timeoutMs: 15_000 })
      .pipe(
        Effect.mapError((cause) =>
          launchProbeError({ path, attemptedVersion, platformId, exitCode: -1, cause }),
        ),
      );
    if (result.exitCode === 0) return;
    return yield* Effect.fail(
      launchProbeError({
        path,
        platformId,
        attemptedVersion,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
    );
  });

const applyPosixSelfUpdate = ({
  attemptedVersion,
  binaryBytes,
  executablePath,
  selfUpdate,
}: {
  readonly attemptedVersion: string;
  readonly binaryBytes: Uint8Array;
  readonly executablePath: string;
  readonly selfUpdate: ResolvedSelfUpdateOptions;
}): Effect.Effect<void, UpdateLaunchProbeError | UpdatePermissionError, ProcessRunner> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(dirname(executablePath), ".lando-update-")),
      catch: (cause) =>
        new UpdatePermissionError({
          message: `Failed to create update temp directory next to ${executablePath}.`,
          path: executablePath,
          remediation: posixPermissionRemediation(executablePath),
          cause,
        }),
    }),
    (tempDir) =>
      Effect.gen(function* () {
        const tempBinaryPath = join(tempDir, basename(executablePath));
        const backupPath = `${executablePath}.bak`;
        const platformId = updatePlatformId(selfUpdate);
        yield* writeDownloadedBinary(tempBinaryPath, binaryBytes, executablePath);
        yield* runLaunchProbe(tempBinaryPath, attemptedVersion, platformId);
        yield* renameForUpdate(selfUpdate.rename, executablePath, backupPath, executablePath);
        yield* renameForUpdate(selfUpdate.rename, tempBinaryPath, executablePath, executablePath).pipe(
          Effect.catchAll((error) =>
            renameForUpdate(selfUpdate.rename, backupPath, executablePath, executablePath).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        yield* runLaunchProbe(executablePath, attemptedVersion, platformId).pipe(
          Effect.catchAll((error) =>
            Effect.tryPromise({
              try: () => selfUpdate.rename(backupPath, executablePath),
              catch: (rollbackFailure) =>
                isPermissionCause(rollbackFailure)
                  ? new UpdatePermissionError({
                      message: `Failed to restore backup ${backupPath} to ${executablePath}.`,
                      path: executablePath,
                      remediation: posixPermissionRemediation(executablePath),
                      cause: rollbackFailure,
                    })
                  : withRollbackFailure(error, rollbackFailure),
            }).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );
        // The candidate has been renamed into place, so the temp dir is empty. Remove
        // it now because a successful execve replaces the process before the finalizer runs.
        yield* cleanupUpdateTempDir(tempDir);
        const execArgv = [executablePath, ...reexecUserArgv(selfUpdate.argv)];
        yield* selfUpdate
          .execve({ path: executablePath, argv: execArgv, env: stringEnv(selfUpdate.env) })
          .pipe(
            Effect.mapError(
              (cause) =>
                new UpdatePermissionError({
                  message: `Failed to exec updated Lando binary at ${executablePath}.`,
                  path: executablePath,
                  remediation: posixPermissionRemediation(executablePath),
                  cause,
                }),
            ),
            Effect.tapError(() =>
              // rename(2) atomically replaces the destination; do not rm first or the
              // executable path is briefly absent on rollback.
              Effect.tryPromise({
                try: () => selfUpdate.rename(backupPath, executablePath),
                catch: () => undefined,
              }).pipe(Effect.catchAll(() => Effect.void)),
            ),
          );
      }),
    cleanupUpdateTempDir,
  );

const applyWindowsSelfUpdate = ({
  attemptedVersion,
  binaryBytes,
  executablePath,
  selfUpdate,
}: {
  readonly attemptedVersion: string;
  readonly binaryBytes: Uint8Array;
  readonly executablePath: string;
  readonly selfUpdate: ResolvedSelfUpdateOptions;
}): Effect.Effect<void, UpdateLaunchProbeError | UpdatePermissionError, ProcessRunner> =>
  Effect.gen(function* () {
    const tempDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(dirname(executablePath), ".lando-update-")),
      catch: (cause) =>
        new UpdatePermissionError({
          message: `Failed to create update temp directory next to ${executablePath}.`,
          path: executablePath,
          remediation: windowsPermissionRemediation(executablePath),
          cause,
        }),
    });
    const stagedBinaryPath = join(tempDir, basename(executablePath));
    const backupPath = `${executablePath}.bak`;
    const manualFallback = windowsManualFallback({ executablePath, stagedBinaryPath, backupPath });
    const replacementInput: UpdateWindowsReplacementInput = {
      executablePath,
      stagedBinaryPath,
      backupPath,
      attemptedVersion,
      argv: [executablePath, ...reexecUserArgv(selfUpdate.argv)],
      env: stringEnv(selfUpdate.env),
      manualFallback,
    };

    yield* writeDownloadedBinary(stagedBinaryPath, binaryBytes, executablePath, manualFallback).pipe(
      Effect.tapError(() => cleanupUpdateTempDir(tempDir)),
    );
    yield* runLaunchProbe(stagedBinaryPath, attemptedVersion, updatePlatformId(selfUpdate)).pipe(
      Effect.tapError(() => cleanupUpdateTempDir(tempDir)),
    );
    yield* selfUpdate.replaceWindows(replacementInput).pipe(
      Effect.mapError(
        (cause) =>
          new UpdatePermissionError({
            message: `Failed to schedule Windows Lando replacement for ${executablePath}.`,
            path: executablePath,
            remediation: manualFallback,
            cause,
          }),
      ),
      Effect.tapError(() => cleanupUpdateTempDir(tempDir)),
    );
  });

const applySelfUpdate = ({
  attemptedVersion,
  binaryBytes,
  executablePath,
  selfUpdate,
}: {
  readonly attemptedVersion: string;
  readonly binaryBytes: Uint8Array;
  readonly executablePath: string;
  readonly selfUpdate: ResolvedSelfUpdateOptions;
}): Effect.Effect<void, UpdateLaunchProbeError | UpdatePermissionError, ProcessRunner> =>
  selfUpdate.platform === "win32"
    ? applyWindowsSelfUpdate({ attemptedVersion, binaryBytes, executablePath, selfUpdate })
    : applyPosixSelfUpdate({ attemptedVersion, binaryBytes, executablePath, selfUpdate });

interface DefaultUpdateSuccess {
  readonly manifest: UpdateManifest;
  readonly result: UpdateResult;
}

const defaultUpdate = (
  options: RequiredUpdateOptions,
): Effect.Effect<DefaultUpdateSuccess, Exclude<UpdateError, LandoCommandError>, ProcessRunner> =>
  Effect.gen(function* () {
    const manifestUrl = resolveUpdateManifestUrl(options.channel);
    const signatureUrl = `${manifestUrl}.sig`;
    const certificateUrl = `${manifestUrl}.crt`;
    const [manifestBytes, signatureBytes, certificateBytes] = yield* Effect.all([
      fetchBytes(options.fetchManifestBytes, manifestUrl),
      fetchBytes(options.fetchManifestBytes, signatureUrl),
      fetchBytes(options.fetchManifestBytes, certificateUrl),
    ]);
    yield* verifyManifestSignature(options.verifyManifestSignature, {
      manifestUrl,
      manifestBytes,
      signatureUrl,
      signatureBytes,
      certificateUrl,
      certificateBytes,
    });
    const manifest = yield* parseJson(manifestBytes, manifestUrl).pipe(
      Effect.flatMap((json) => decodeManifest(json, manifestUrl)),
    );
    if (manifest.channel !== options.channel) {
      return yield* Effect.fail(
        new UpdateNetworkError({
          message: `Update manifest channel ${manifest.channel} does not match requested channel ${options.channel}.`,
          url: manifestUrl,
        }),
      );
    }
    const selfUpdate = resolveSelfUpdateOptions(options.selfUpdate);
    const manifestPlatform = updateManifestPlatform(selfUpdate);
    const binary = manifest.binaries[manifestPlatform];
    if (binary === undefined) {
      return yield* Effect.fail(
        new UpdateNetworkError({
          message: `Update manifest at ${manifestUrl} has no binary entry for ${manifestPlatform}.`,
          url: manifestUrl,
        }),
      );
    }
    if (isPlaceholderBinary(binary)) {
      return yield* Effect.fail(
        new UpdateNetworkError({
          message: `Update manifest at ${manifestUrl} has a placeholder binary entry for ${manifestPlatform}.`,
          url: manifestUrl,
        }),
      );
    }
    const binaryUrl = binary.url;
    const checksumsUrl = manifest.checksums.url;
    const checksumSignatureUrl = manifest.checksums.signature;
    const checksumCertificateUrl = checksumCertificateUrlFor(checksumSignatureUrl);
    yield* enforceMinimumVersion(manifest, options.currentVersion);
    yield* enforceNoDowngrade(manifest, options.currentVersion);
    yield* enforceManifestFreshness(manifest, options.updateStatePath, { persist: !options.dryRun });
    const hasNewCoreVersion = compareVersions(manifest.latest, options.currentVersion) > 0;
    if (!options.dryRun && selfUpdate !== undefined && hasNewCoreVersion) {
      const [binaryBytes, checksumsBytes, checksumSignatureBytes, checksumCertificateBytes] =
        yield* Effect.all([
          fetchBytes(options.fetchManifestBytes, binaryUrl),
          fetchBytes(options.fetchManifestBytes, checksumsUrl),
          fetchBytes(options.fetchManifestBytes, checksumSignatureUrl),
          fetchBytes(options.fetchManifestBytes, checksumCertificateUrl),
        ]);
      yield* verifyChecksumSignature(options.verifyChecksumSignature, {
        checksumsUrl,
        checksumsBytes,
        signatureUrl: checksumSignatureUrl,
        signatureBytes: checksumSignatureBytes,
        certificateUrl: checksumCertificateUrl,
        certificateBytes: checksumCertificateBytes,
      });
      yield* verifyBinaryChecksum({
        artifact: artifactNameFromUrl(binaryUrl),
        binaryBytes,
        checksumsBytes,
        manifestSha256: binary.sha256,
      });
      yield* applySelfUpdate({
        attemptedVersion: manifest.latest,
        binaryBytes,
        executablePath: selfUpdate.executablePath,
        selfUpdate,
      }).pipe(
        Effect.tapError((error) =>
          writeUpdateFailureState({
            path: options.updateStatePath,
            channel: options.channel,
            category: failureOutcomeFromError(error),
            targetVersion: manifest.latest,
            platform: platform(),
          }),
        ),
      );
    }
    if (!options.dryRun) {
      const state = yield* readUpdateManifestState(options.updateStatePath);
      const cached = state[manifest.channel];
      yield* writeUpdateManifestState(options.updateStatePath, {
        ...state,
        [manifest.channel]: { ...cached, latest: manifest.latest },
      });
    }
    return {
      manifest,
      result: {
        updatedCore: !options.dryRun && hasNewCoreVersion,
        updatedPlugins: [],
      },
    };
  });

interface RequiredUpdateOptions {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly dryRun: boolean;
  readonly fetchManifestBytes: UpdateManifestFetcher;
  readonly selfUpdate: false | UpdateSelfUpdateOptions | undefined;
  readonly updateStatePath: string;
  readonly verifyChecksumSignature: UpdateChecksumSignatureVerifier;
  readonly verifyManifestSignature: UpdateManifestSignatureVerifier;
}

const resolvedOptions = (options: UpdateOptions): RequiredUpdateOptions => ({
  currentVersion: options.currentVersion ?? CORE_VERSION,
  channel: options.channel ?? updateChannelForVersion(options.currentVersion ?? CORE_VERSION),
  dryRun: options.dryRun === true,
  fetchManifestBytes: options.fetchManifestBytes ?? defaultFetchManifestBytes,
  selfUpdate: options.selfUpdate,
  updateStatePath: options.updateStatePath ?? updateManifestStatePath(),
  verifyChecksumSignature: options.verifyChecksumSignature ?? defaultVerifyChecksumSignature,
  verifyManifestSignature: options.verifyManifestSignature ?? defaultVerifyManifestSignature,
});

export const update = (
  options: UpdateOptions = {},
): Effect.Effect<UpdateResult, UpdateError, Telemetry | ProcessRunner> =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const required = resolvedOptions(options);
    let targetVersion = options.targetVersion ?? CORE_VERSION;
    const operation =
      options.runUpdate === undefined
        ? defaultUpdate(required).pipe(
            Effect.tap(({ manifest }) =>
              Effect.sync(() => {
                targetVersion = manifest.latest;
              }),
            ),
            Effect.map(({ result }) => result),
          )
        : options.runUpdate();

    return yield* operation.pipe(
      Effect.tap(() =>
        recordUpdateOutcomeTelemetry(telemetry, {
          version: CORE_VERSION,
          targetVersion,
          channel: required.channel,
          platform: platform(),
          outcome: "success",
        }),
      ),
      Effect.tapError((error) =>
        recordUpdateOutcomeTelemetry(telemetry, {
          version: CORE_VERSION,
          targetVersion,
          channel: required.channel,
          platform: platform(),
          outcome: updateOutcomeFromError(error),
        }),
      ),
    );
  });
