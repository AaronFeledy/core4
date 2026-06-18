/**
 * `lando update` — check / apply updates to core and plugins.
 *
 * Release channels: `stable`, `next`, `dev`. Bootstrap level: `plugins`.
 *
 * The compiled binary self-updates by writing a new binary alongside,
 * atomic-renaming, and re-execing.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Effect, Either, Schema } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import {
  type UpdateChannel,
  UpdateChannel as UpdateChannelSchema,
  type UpdateManifestSchema as UpdateManifest,
  UpdateManifestSchema,
} from "@lando/sdk/schema";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { resolveUserCacheRoot } from "../../cache/paths.ts";
import { recordUpdateOutcomeTelemetry, updateOutcomeFromError } from "../../telemetry/events.ts";
import { scrubTelemetryValue } from "../../telemetry/redaction.ts";
import { CORE_VERSION } from "../../version.ts";

export class UpdateNetworkError extends Schema.TaggedError<UpdateNetworkError>()("UpdateNetworkError", {
  message: Schema.String,
  url: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class UpdateSignatureVerificationError extends Schema.TaggedError<UpdateSignatureVerificationError>()(
  "UpdateSignatureVerificationError",
  {
    message: Schema.String,
    manifestUrl: Schema.String,
    signatureUrl: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class UpdateMinimumVersionError extends Schema.TaggedError<UpdateMinimumVersionError>()(
  "UpdateMinimumVersionError",
  {
    message: Schema.String,
    currentVersion: Schema.String,
    minimumVersion: Schema.String,
    remediation: Schema.String,
  },
) {}

export class UpdateDowngradeError extends Schema.TaggedError<UpdateDowngradeError>()("UpdateDowngradeError", {
  message: Schema.String,
  currentVersion: Schema.String,
  manifestVersion: Schema.String,
  remediation: Schema.String,
}) {}

export class UpdateManifestReplayError extends Schema.TaggedError<UpdateManifestReplayError>()(
  "UpdateManifestReplayError",
  {
    message: Schema.String,
    channel: UpdateChannelSchema,
    cachedVersion: Schema.String,
    manifestVersion: Schema.String,
  },
) {}

export class UpdateChecksumSignatureVerificationError extends Schema.TaggedError<UpdateChecksumSignatureVerificationError>()(
  "UpdateChecksumSignatureVerificationError",
  {
    message: Schema.String,
    checksumsUrl: Schema.String,
    signatureUrl: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class UpdateChecksumVerificationError extends Schema.TaggedError<UpdateChecksumVerificationError>()(
  "UpdateChecksumVerificationError",
  {
    message: Schema.String,
    artifact: Schema.String,
    expected: Schema.optional(Schema.String),
    actual: Schema.optional(Schema.String),
  },
) {}

export class UpdateLaunchProbeError extends Schema.TaggedError<UpdateLaunchProbeError>()(
  "UpdateLaunchProbeError",
  {
    message: Schema.String,
    platform: Schema.String,
    attemptedVersion: Schema.String,
    probeCommand: Schema.String,
    outputSummary: Schema.String,
    exitCode: Schema.Number,
    rollbackFailure: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class UpdatePermissionError extends Schema.TaggedError<UpdatePermissionError>()(
  "UpdatePermissionError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type UpdateError =
  | LandoCommandError
  | UpdateNetworkError
  | UpdateSignatureVerificationError
  | UpdateMinimumVersionError
  | UpdateDowngradeError
  | UpdateManifestReplayError
  | UpdateChecksumSignatureVerificationError
  | UpdateChecksumVerificationError
  | UpdateLaunchProbeError
  | UpdatePermissionError;

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

export interface UpdateManifestSignatureInput {
  readonly manifestUrl: string;
  readonly manifestBytes: Uint8Array;
  readonly signatureUrl: string;
  readonly signatureBytes: Uint8Array;
  readonly certificateUrl: string;
  readonly certificateBytes: Uint8Array;
}

export interface UpdateChecksumSignatureInput {
  readonly checksumsUrl: string;
  readonly checksumsBytes: Uint8Array;
  readonly signatureUrl: string;
  readonly signatureBytes: Uint8Array;
  readonly certificateUrl: string;
  readonly certificateBytes: Uint8Array;
}

export interface UpdateExecveInput {
  readonly path: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}

export type UpdateExecve = (input: UpdateExecveInput) => Effect.Effect<void, unknown, never>;
export type UpdateRename = (from: string, to: string) => Promise<void>;

export interface UpdateSelfUpdateOptions {
  readonly executablePath?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execve?: UpdateExecve;
  readonly rename?: UpdateRename;
}

export type UpdateManifestFetcher = (url: string) => Promise<Uint8Array>;
export type UpdateManifestSignatureVerifier = (
  input: UpdateManifestSignatureInput,
) => Effect.Effect<void, unknown, ProcessRunner>;
export type UpdateChecksumSignatureVerifier = (
  input: UpdateChecksumSignatureInput,
) => Effect.Effect<void, unknown, ProcessRunner>;

const UPDATE_BASE_URL = "https://update.lando.dev/v4";
const UPDATE_COSIGN_CERTIFICATE_IDENTITY_REGEXP =
  "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$";
const updateManifestStatePath = (): string => join(resolveUserCacheRoot(), "update-manifest-state.json");

export const resolveUpdateManifestUrl = (channel: UpdateChannel): string =>
  `${UPDATE_BASE_URL}/${channel}.json`;

const normalizeVersion = (version: string): string => (version.startsWith("v") ? version.slice(1) : version);

const prereleaseChannelIdentifier = (version: string): string => {
  const normalized = normalizeVersion(version);
  const withoutBuild = normalized.split("+", 1)[0] ?? normalized;
  const prereleaseIndex = withoutBuild.indexOf("-");
  if (prereleaseIndex === -1) return "";
  const prerelease = withoutBuild.slice(prereleaseIndex + 1);
  return prerelease.split(".", 1)[0] ?? prerelease;
};

export const updateChannelForVersion = (version: string): UpdateChannel => {
  const identifier = prereleaseChannelIdentifier(version);
  if (identifier === "dev" || identifier === "alpha") return "dev";
  if (identifier === "next" || identifier === "beta" || identifier === "rc") return "next";
  return "stable";
};

const platform = (): string => `${process.platform}-${process.arch}`;

const updateManifestPlatform = (): keyof UpdateManifest["binaries"] =>
  process.platform === "win32"
    ? "windows-x64"
    : (`${process.platform}-${process.arch}` as keyof UpdateManifest["binaries"]);

const isPlaceholderBinary = (binary: UpdateManifest["binaries"][keyof UpdateManifest["binaries"]]): boolean =>
  binary.size === 0 || binary.sha256 === "" || /^0+$/u.test(binary.sha256);

const defaultFetchManifestBytes: UpdateManifestFetcher = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
};

const defaultVerifyManifestSignature: UpdateManifestSignatureVerifier = ({
  certificateBytes,
  manifestBytes,
  manifestUrl,
  signatureBytes,
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "lando-update-manifest-"))),
    (root) =>
      Effect.gen(function* () {
        const processRunner = yield* ProcessRunner;
        const manifestPath = join(root, "manifest.json");
        const signaturePath = join(root, "manifest.sig");
        const certificatePath = join(root, "manifest.crt");
        yield* Effect.tryPromise(() =>
          Promise.all([
            writeFile(manifestPath, manifestBytes),
            writeFile(signaturePath, signatureBytes),
            writeFile(certificatePath, certificateBytes),
          ]),
        );
        const result = yield* processRunner.run({
          cmd: "cosign",
          args: [
            "verify-blob",
            "--certificate-identity-regexp",
            UPDATE_COSIGN_CERTIFICATE_IDENTITY_REGEXP,
            "--certificate-oidc-issuer",
            "https://token.actions.githubusercontent.com",
            "--signature",
            signaturePath,
            "--certificate",
            certificatePath,
            manifestPath,
          ],
        });
        if (result.exitCode !== 0) {
          const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 500);
          return yield* Effect.fail(
            new Error(
              `cosign verify-blob failed for ${manifestUrl}${output.length === 0 ? "" : `: ${output}`}`,
            ),
          );
        }
      }),
    (root) =>
      Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(
        Effect.catchAll(() => Effect.void),
      ),
  );

const defaultVerifyChecksumSignature: UpdateChecksumSignatureVerifier = ({
  certificateBytes,
  checksumsBytes,
  checksumsUrl,
  signatureBytes,
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "lando-update-checksums-"))),
    (root) =>
      Effect.gen(function* () {
        const processRunner = yield* ProcessRunner;
        const checksumsPath = join(root, "SHA256SUMS");
        const signaturePath = join(root, "SHA256SUMS.sig");
        const certificatePath = join(root, "SHA256SUMS.crt");
        yield* Effect.tryPromise(() =>
          Promise.all([
            writeFile(checksumsPath, checksumsBytes),
            writeFile(signaturePath, signatureBytes),
            writeFile(certificatePath, certificateBytes),
          ]),
        );
        const result = yield* processRunner.run({
          cmd: "cosign",
          args: [
            "verify-blob",
            "--certificate-identity-regexp",
            UPDATE_COSIGN_CERTIFICATE_IDENTITY_REGEXP,
            "--certificate-oidc-issuer",
            "https://token.actions.githubusercontent.com",
            "--signature",
            signaturePath,
            "--certificate",
            certificatePath,
            checksumsPath,
          ],
        });
        if (result.exitCode !== 0) {
          const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 500);
          return yield* Effect.fail(
            new Error(
              `cosign verify-blob failed for ${checksumsUrl}${output.length === 0 ? "" : `: ${output}`}`,
            ),
          );
        }
      }),
    (root) =>
      Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(
        Effect.catchAll(() => Effect.void),
      ),
  );

const fetchBytes = (
  fetcher: UpdateManifestFetcher,
  url: string,
): Effect.Effect<Uint8Array, UpdateNetworkError> =>
  Effect.tryPromise({
    try: () => fetcher(url),
    catch: (cause) =>
      new UpdateNetworkError({
        message: `Failed to fetch update metadata from ${url}.`,
        url,
        cause,
      }),
  });

const parseJson = (bytes: Uint8Array, url: string): Effect.Effect<unknown, UpdateNetworkError> =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) =>
      new UpdateNetworkError({
        message: `Update manifest at ${url} is not valid JSON.`,
        url,
        cause,
      }),
  });

const decodeManifest = (input: unknown, url: string): Effect.Effect<UpdateManifest, UpdateNetworkError> => {
  const decoded = Schema.decodeUnknownEither(UpdateManifestSchema)(input, { onExcessProperty: "error" });
  return Either.isRight(decoded)
    ? Effect.succeed(decoded.right)
    : Effect.fail(
        new UpdateNetworkError({
          message: `Update manifest at ${url} failed schema validation.`,
          url,
          cause: decoded.left,
        }),
      );
};

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

const compareNumbers = (left: number, right: number): number => {
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
};

const parseVersion = (version: string): ParsedVersion => {
  const normalized = normalizeVersion(version);
  const withoutBuild = normalized.split("+", 1)[0] ?? normalized;
  const prereleaseIndex = withoutBuild.indexOf("-");
  const core = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
  const prerelease = prereleaseIndex === -1 ? [] : withoutBuild.slice(prereleaseIndex + 1).split(".");
  const [major = "0", minor = "0", patch = "0"] = core.split(".");

  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease,
  };
};

const isNumericPrereleaseIdentifier = (identifier: string): boolean => /^\d+$/u.test(identifier);

const normalizeNumericPrereleaseIdentifier = (identifier: string): string =>
  identifier.replace(/^0+/u, "") || "0";

const compareNumericPrereleaseIdentifiers = (left: string, right: string): number => {
  const normalizedLeft = normalizeNumericPrereleaseIdentifier(left);
  const normalizedRight = normalizeNumericPrereleaseIdentifier(right);
  const lengthComparison = compareNumbers(normalizedLeft.length, normalizedRight.length);
  if (lengthComparison !== 0) return lengthComparison;
  if (normalizedLeft > normalizedRight) return 1;
  if (normalizedLeft < normalizedRight) return -1;
  return 0;
};

const comparePrereleaseIdentifier = (left: string, right: string): number => {
  const leftIsNumeric = isNumericPrereleaseIdentifier(left);
  const rightIsNumeric = isNumericPrereleaseIdentifier(right);
  if (leftIsNumeric && rightIsNumeric) return compareNumericPrereleaseIdentifiers(left, right);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
};

const comparePrerelease = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = comparePrereleaseIdentifier(left[index] ?? "", right[index] ?? "");
    if (comparison !== 0) return comparison;
  }

  return compareNumbers(left.length, right.length);
};

const compareVersions = (left: string, right: string): number => {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const majorComparison = compareNumbers(leftVersion.major, rightVersion.major);
  if (majorComparison !== 0) return majorComparison;
  const minorComparison = compareNumbers(leftVersion.minor, rightVersion.minor);
  if (minorComparison !== 0) return minorComparison;
  const patchComparison = compareNumbers(leftVersion.patch, rightVersion.patch);
  if (patchComparison !== 0) return patchComparison;
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
};

const manualUpdateRemediation = (version: string): string =>
  `Install a current Lando v4 binary with the official installer, or download v${version} or newer from GitHub Releases, then rerun lando update.`;

const downgradeRemediation = (version: string): string =>
  `The signed update manifest points to ${version}, which is older than this binary. Use an explicit installer or GitHub Releases if you need to downgrade manually.`;

const enforceMinimumVersion = (
  manifest: UpdateManifest,
  currentVersion: string,
): Effect.Effect<void, UpdateMinimumVersionError> =>
  compareVersions(currentVersion, manifest.minimum) >= 0
    ? Effect.void
    : Effect.fail(
        new UpdateMinimumVersionError({
          message: `This Lando binary (${currentVersion}) is older than the update protocol minimum (${manifest.minimum}). Manual update is required.`,
          currentVersion,
          minimumVersion: manifest.minimum,
          remediation: manualUpdateRemediation(manifest.minimum),
        }),
      );

const enforceNoDowngrade = (
  manifest: UpdateManifest,
  currentVersion: string,
): Effect.Effect<void, UpdateDowngradeError> =>
  compareVersions(manifest.latest, currentVersion) >= 0
    ? Effect.void
    : Effect.fail(
        new UpdateDowngradeError({
          message: `Update manifest latest version (${manifest.latest}) is older than this Lando binary (${currentVersion}). Refusing to downgrade automatically.`,
          currentVersion,
          manifestVersion: manifest.latest,
          remediation: downgradeRemediation(manifest.latest),
        }),
      );

const UpdateFailureCategorySchema = Schema.Literal(
  "signature_failure",
  "launch_probe_failure",
  "permission_failure",
  "network_failure",
);
type UpdateFailureCategory = typeof UpdateFailureCategorySchema.Type;

interface UpdateManifestStateEntry {
  readonly latest: string;
  readonly lastFailure?:
    | {
        readonly category: UpdateFailureCategory;
        readonly targetVersion: string;
        readonly platform: string;
      }
    | undefined;
}

const UpdateManifestStateSchema = Schema.partial(
  Schema.Record({
    key: UpdateChannelSchema,
    value: Schema.Struct({
      latest: Schema.String,
      lastFailure: Schema.optional(
        Schema.Struct({
          category: UpdateFailureCategorySchema,
          targetVersion: Schema.String,
          platform: Schema.String,
        }),
      ),
    }),
  }),
);
type DecodedUpdateManifestState = typeof UpdateManifestStateSchema.Type;
type UpdateManifestState = Partial<Record<UpdateChannel, UpdateManifestStateEntry>>;

const normalizeUpdateManifestState = (state: DecodedUpdateManifestState): UpdateManifestState => ({
  ...(state.stable === undefined ? {} : { stable: state.stable }),
  ...(state.next === undefined ? {} : { next: state.next }),
  ...(state.dev === undefined ? {} : { dev: state.dev }),
});

const emptyUpdateManifestState: UpdateManifestState = {};

const readUpdateManifestState = (path: string): Effect.Effect<UpdateManifestState, UpdateNetworkError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) =>
      new UpdateNetworkError({
        message: `Failed to read update manifest freshness state at ${path}.`,
        url: path,
        cause,
      }),
  }).pipe(
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed({});
      const decoded = Schema.decodeUnknownEither(UpdateManifestStateSchema)(raw, {
        onExcessProperty: "error",
      });
      return Either.isRight(decoded)
        ? Effect.succeed(normalizeUpdateManifestState(decoded.right))
        : Effect.fail(
            new UpdateNetworkError({
              message: `Update manifest freshness state at ${path} failed schema validation.`,
              url: path,
              cause: decoded.left,
            }),
          );
    }),
  );

const writeUpdateManifestState = (
  path: string,
  state: UpdateManifestState,
): Effect.Effect<void, UpdateNetworkError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(path, `${JSON.stringify(state, null, 2)}\n`),
    catch: (cause) =>
      new UpdateNetworkError({
        message: `Failed to write update manifest freshness state at ${path}.`,
        url: path,
        cause,
      }),
  });

const writeUpdateFailureState = ({
  category,
  channel,
  path,
  platform,
  targetVersion,
}: {
  readonly path: string;
  readonly channel: UpdateChannel;
  readonly category: Exclude<ReturnType<typeof updateOutcomeFromError>, "success">;
  readonly targetVersion: string;
  readonly platform: string;
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const state = yield* readUpdateManifestState(path).pipe(
      Effect.catchAll(() => Effect.succeed(emptyUpdateManifestState)),
    );
    const current = state[channel];
    yield* writeUpdateManifestState(path, {
      ...state,
      [channel]: {
        latest: current?.latest ?? targetVersion,
        lastFailure: { category, targetVersion, platform },
      },
    }).pipe(Effect.catchAll(() => Effect.void));
  });

const failureOutcomeFromError = (
  error: unknown,
): Exclude<ReturnType<typeof updateOutcomeFromError>, "success"> => {
  const outcome = updateOutcomeFromError(error);
  return outcome === "success" ? "network_failure" : outcome;
};

const enforceManifestFreshness = (
  manifest: UpdateManifest,
  statePath: string,
  options: { readonly persist: boolean },
): Effect.Effect<void, UpdateNetworkError | UpdateManifestReplayError> =>
  Effect.gen(function* () {
    const state = yield* readUpdateManifestState(statePath);
    const cached = state[manifest.channel];
    if (cached !== undefined && compareVersions(manifest.latest, cached.latest) < 0) {
      return yield* Effect.fail(
        new UpdateManifestReplayError({
          message: `Update manifest ${manifest.channel} channel version ${manifest.latest} is older than previously observed signed version ${cached.latest}. Refusing possible manifest replay.`,
          channel: manifest.channel,
          cachedVersion: cached.latest,
          manifestVersion: manifest.latest,
        }),
      );
    }

    if (!options.persist) return;

    yield* writeUpdateManifestState(statePath, {
      ...state,
      [manifest.channel]: { ...cached, latest: manifest.latest },
    });
  });

const verifyManifestSignature = (
  verifier: UpdateManifestSignatureVerifier,
  input: UpdateManifestSignatureInput,
): Effect.Effect<void, UpdateSignatureVerificationError, ProcessRunner> =>
  verifier(input).pipe(
    Effect.mapError(
      (cause) =>
        new UpdateSignatureVerificationError({
          message: `Update manifest signature verification failed for ${input.manifestUrl}.`,
          manifestUrl: input.manifestUrl,
          signatureUrl: input.signatureUrl,
          cause,
        }),
    ),
  );

const verifyChecksumSignature = (
  verifier: UpdateChecksumSignatureVerifier,
  input: UpdateChecksumSignatureInput,
): Effect.Effect<void, UpdateChecksumSignatureVerificationError, ProcessRunner> =>
  verifier(input).pipe(
    Effect.mapError(
      (cause) =>
        new UpdateChecksumSignatureVerificationError({
          message: `Update checksum signature verification failed for ${input.checksumsUrl}.`,
          checksumsUrl: input.checksumsUrl,
          signatureUrl: input.signatureUrl,
          cause,
        }),
    ),
  );

const checksumCertificateUrlFor = (signatureUrl: string): string => {
  if (signatureUrl.endsWith(".sig")) return `${signatureUrl.slice(0, -4)}.crt`;
  return `${signatureUrl}.crt`;
};

const artifactNameFromUrl = (url: string): string => {
  try {
    return basename(new URL(url).pathname);
  } catch {
    return basename(url);
  }
};

const normalizeChecksumPath = (path: string): string => path.replace(/^\*/u, "").replace(/^\.\//u, "");

const checksumEntryForArtifact = (checksums: string, artifact: string): string | undefined => {
  for (const line of checksums.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(?<sha>[a-fA-F0-9]{64})\s+(?<path>.+)$/u.exec(trimmed);
    if (match?.groups === undefined) continue;
    const sha = match.groups.sha;
    const path = match.groups.path;
    if (sha === undefined || path === undefined) continue;
    const entryPath = normalizeChecksumPath(path.trim());
    if (basename(entryPath) === artifact) return sha.toLowerCase();
  }
  return undefined;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const verifyBinaryChecksum = ({
  artifact,
  binaryBytes,
  checksumsBytes,
  manifestSha256,
}: {
  readonly artifact: string;
  readonly binaryBytes: Uint8Array;
  readonly checksumsBytes: Uint8Array;
  readonly manifestSha256: string;
}): Effect.Effect<void, UpdateChecksumVerificationError> =>
  Effect.sync(() => new TextDecoder().decode(checksumsBytes)).pipe(
    Effect.flatMap((checksums) => {
      const expected = checksumEntryForArtifact(checksums, artifact);
      if (expected === undefined) {
        return Effect.fail(
          new UpdateChecksumVerificationError({
            message: `Update checksums do not contain an entry for ${artifact}.`,
            artifact,
          }),
        );
      }
      if (expected !== manifestSha256.toLowerCase()) {
        return Effect.fail(
          new UpdateChecksumVerificationError({
            message: `Update manifest checksum for ${artifact} does not match the signed checksum manifest.`,
            artifact,
            expected,
            actual: manifestSha256.toLowerCase(),
          }),
        );
      }
      const actual = sha256Hex(binaryBytes);
      return actual === expected
        ? Effect.void
        : Effect.fail(
            new UpdateChecksumVerificationError({
              message: `Downloaded update artifact ${artifact} failed checksum verification.`,
              artifact,
              expected,
              actual,
            }),
          );
    }),
  );

const stringEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

interface ExecveProcess {
  readonly execve?: (path: string, argv: ReadonlyArray<string>, env: Record<string, string>) => never;
}

const defaultExecve: UpdateExecve = (input) =>
  Effect.try({
    try: () => {
      const execve = (process as ExecveProcess).execve;
      if (execve === undefined) throw new Error("process.execve is not available in this runtime");
      execve(input.path, input.argv, input.env);
    },
    catch: (cause) => cause,
  });

const isLikelyLandoExecutable = (path: string): boolean => basename(path).startsWith("lando");

const defaultSelfUpdateExecutablePath = (): string | undefined => {
  if (process.platform === "win32") return undefined;
  return isLikelyLandoExecutable(process.execPath) ? process.execPath : undefined;
};

const resolveSelfUpdateOptions = (
  input: false | UpdateSelfUpdateOptions | undefined,
):
  | Required<Pick<UpdateSelfUpdateOptions, "executablePath" | "argv" | "env" | "execve" | "rename">>
  | undefined => {
  if (input === false || process.platform === "win32") return undefined;
  const executablePath = input?.executablePath ?? defaultSelfUpdateExecutablePath();
  if (executablePath === undefined) return undefined;
  return {
    executablePath,
    argv: input?.argv ?? process.argv,
    env: input?.env ?? process.env,
    execve: input?.execve ?? defaultExecve,
    rename: input?.rename ?? rename,
  };
};

const writeDownloadedBinary = (path: string, bytes: Uint8Array): Effect.Effect<void, UpdatePermissionError> =>
  Effect.tryPromise({
    try: async () => {
      await writeFile(path, bytes);
      await chmod(path, 0o755);
    },
    catch: (cause) =>
      new UpdatePermissionError({
        message: `Failed to write executable update artifact at ${path}.`,
        path,
        cause,
      }),
  });

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
  stderr,
  stdout,
}: {
  readonly path: string;
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
    message: `Downloaded Lando ${attemptedVersion} failed its launch probe on ${platform()}.`,
    platform: platform(),
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
): Effect.Effect<void, UpdateLaunchProbeError, ProcessRunner> =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const result = yield* processRunner
      .run({ cmd: path, args: ["--version"], timeoutMs: 15_000 })
      .pipe(Effect.mapError((cause) => launchProbeError({ path, attemptedVersion, exitCode: -1, cause })));
    if (result.exitCode === 0) return;
    return yield* Effect.fail(
      launchProbeError({
        path,
        attemptedVersion,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
    );
  });

const renameForUpdate = (
  renamePath: UpdateRename,
  from: string,
  to: string,
): Effect.Effect<void, UpdatePermissionError> =>
  Effect.tryPromise({
    try: () => renamePath(from, to),
    catch: (cause) =>
      new UpdatePermissionError({
        message: `Failed to rename ${from} to ${to}.`,
        path: to,
        cause,
      }),
  });

const reexecUserArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const userArgv = argv.slice(1);
  return userArgv[0]?.startsWith("/$bunfs/") === true ? userArgv.slice(1) : userArgv;
};

const applyPosixSelfUpdate = ({
  attemptedVersion,
  binaryBytes,
  executablePath,
  selfUpdate,
}: {
  readonly attemptedVersion: string;
  readonly binaryBytes: Uint8Array;
  readonly executablePath: string;
  readonly selfUpdate: Required<Pick<UpdateSelfUpdateOptions, "argv" | "env" | "execve" | "rename">>;
}): Effect.Effect<void, UpdateLaunchProbeError | UpdatePermissionError, ProcessRunner> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(dirname(executablePath), ".lando-update-")),
      catch: (cause) =>
        new UpdatePermissionError({
          message: `Failed to create update temp directory next to ${executablePath}.`,
          path: executablePath,
          cause,
        }),
    }),
    (tempDir) =>
      Effect.gen(function* () {
        const tempBinaryPath = join(tempDir, basename(executablePath));
        const backupPath = `${executablePath}.bak`;
        yield* writeDownloadedBinary(tempBinaryPath, binaryBytes);
        yield* runLaunchProbe(tempBinaryPath, attemptedVersion);
        yield* renameForUpdate(selfUpdate.rename, executablePath, backupPath);
        yield* renameForUpdate(selfUpdate.rename, tempBinaryPath, executablePath).pipe(
          Effect.catchAll((error) =>
            renameForUpdate(selfUpdate.rename, backupPath, executablePath).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        yield* runLaunchProbe(executablePath, attemptedVersion).pipe(
          Effect.catchAll((error) =>
            Effect.tryPromise({
              try: () => selfUpdate.rename(backupPath, executablePath),
              catch: (cause) => cause,
            }).pipe(
              Effect.catchAll((rollbackFailure) => Effect.fail(withRollbackFailure(error, rollbackFailure))),
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        // The candidate has been renamed into place, so the temp dir is empty. Remove
        // it now because a successful execve replaces the process before the finalizer runs.
        yield* Effect.promise(() => rm(tempDir, { recursive: true, force: true })).pipe(
          Effect.catchAll(() => Effect.void),
        );
        const execArgv = [executablePath, ...reexecUserArgv(selfUpdate.argv)];
        yield* selfUpdate
          .execve({ path: executablePath, argv: execArgv, env: stringEnv(selfUpdate.env) })
          .pipe(
            Effect.mapError(
              (cause) =>
                new UpdatePermissionError({
                  message: `Failed to exec updated Lando binary at ${executablePath}.`,
                  path: executablePath,
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
    (tempDir) =>
      Effect.promise(() => rm(tempDir, { recursive: true, force: true })).pipe(
        Effect.catchAll(() => Effect.void),
      ),
  );

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
    const manifestPlatform = updateManifestPlatform();
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
    const selfUpdate = resolveSelfUpdateOptions(options.selfUpdate);
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
      yield* applyPosixSelfUpdate({
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
