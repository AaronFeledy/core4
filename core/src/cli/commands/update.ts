/**
 * `lando update` — check / apply updates to core and plugins.
 *
 * Release channels: `stable`, `next`, `dev`. Bootstrap level: `plugins`.
 *
 * The compiled binary self-updates by writing a new binary alongside,
 * atomic-renaming, and re-execing.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either, Schema } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { resolveUserCacheRoot } from "../../cache/paths.ts";
import {
  type UpdateChannel,
  UpdateChannel as UpdateChannelSchema,
  type UpdateManifest,
  UpdateManifestSchema,
} from "../../schema/update.ts";
import { recordUpdateOutcomeTelemetry, updateOutcomeFromError } from "../../telemetry/events.ts";
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

export type UpdateError =
  | LandoCommandError
  | UpdateNetworkError
  | UpdateSignatureVerificationError
  | UpdateMinimumVersionError
  | UpdateDowngradeError
  | UpdateManifestReplayError;

export interface UpdateOptions {
  readonly channel?: UpdateChannel;
  /** Check only, don't apply. */
  readonly dryRun?: boolean;
  readonly currentVersion?: string;
  readonly targetVersion?: string;
  readonly fetchManifestBytes?: UpdateManifestFetcher;
  readonly verifyManifestSignature?: UpdateManifestSignatureVerifier;
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

export type UpdateManifestFetcher = (url: string) => Promise<Uint8Array>;
export type UpdateManifestSignatureVerifier = (
  input: UpdateManifestSignatureInput,
) => Effect.Effect<void, unknown, ProcessRunner>;

const UPDATE_BASE_URL = "https://update.lando.dev/v4";
const UPDATE_COSIGN_CERTIFICATE_IDENTITY_REGEXP =
  "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$";
const updateManifestStatePath = (): string => join(resolveUserCacheRoot(), "update-manifest-state.json");

export const resolveUpdateManifestUrl = (channel: UpdateChannel): string =>
  `${UPDATE_BASE_URL}/${channel}.json`;

export const updateChannelForVersion = (version: string): UpdateChannel => {
  const prerelease = version.split("+", 1)[0]?.split("-", 2)[1];
  if (prerelease?.startsWith("alpha") === true) return "dev";
  if (prerelease?.startsWith("beta") === true || prerelease?.startsWith("rc") === true) return "next";
  return "stable";
};

const platform = (): string => `${process.platform}-${process.arch}`;

const updateManifestPlatform = (): keyof UpdateManifest["binaries"] =>
  process.platform === "win32"
    ? "windows-x64"
    : (`${process.platform}-${process.arch}` as keyof UpdateManifest["binaries"]);

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
  const withoutBuild = version.split("+", 1)[0] ?? version;
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

const UpdateManifestStateSchema = Schema.partial(
  Schema.Record({ key: UpdateChannelSchema, value: Schema.Struct({ latest: Schema.String }) }),
);
type UpdateManifestState = typeof UpdateManifestStateSchema.Type;

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
        ? Effect.succeed(decoded.right)
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

const enforceManifestFreshness = (
  manifest: UpdateManifest,
  statePath: string,
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

    yield* writeUpdateManifestState(statePath, {
      ...state,
      [manifest.channel]: { latest: manifest.latest },
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
    const binary = manifest.binaries[updateManifestPlatform()];
    if (binary === undefined) {
      return yield* Effect.fail(
        new UpdateNetworkError({
          message: `Update manifest at ${manifestUrl} has no binary entry for ${updateManifestPlatform()}.`,
          url: manifestUrl,
        }),
      );
    }
    yield* enforceMinimumVersion(manifest, options.currentVersion);
    yield* enforceNoDowngrade(manifest, options.currentVersion);
    yield* enforceManifestFreshness(manifest, options.updateStatePath);
    return { manifest, result: { updatedCore: false, updatedPlugins: [] } };
  });

interface RequiredUpdateOptions {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly dryRun: boolean;
  readonly fetchManifestBytes: UpdateManifestFetcher;
  readonly updateStatePath: string;
  readonly verifyManifestSignature: UpdateManifestSignatureVerifier;
}

const resolvedOptions = (options: UpdateOptions): RequiredUpdateOptions => ({
  currentVersion: options.currentVersion ?? CORE_VERSION,
  channel: options.channel ?? updateChannelForVersion(options.currentVersion ?? CORE_VERSION),
  dryRun: options.dryRun === true,
  fetchManifestBytes: options.fetchManifestBytes ?? defaultFetchManifestBytes,
  updateStatePath: options.updateStatePath ?? updateManifestStatePath(),
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
