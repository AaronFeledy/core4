/** Update manifest location, decoding, version policy, and freshness state. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either, Layer, Schema } from "effect";

import { DownloaderLive } from "@lando/http-client/downloader";
import { HttpClientLive } from "@lando/http-client/live";
import {
  type UpdateChannel,
  UpdateChannel as UpdateChannelSchema,
  type UpdateManifestSchema as UpdateManifest,
  UpdateManifestSchema,
} from "@lando/sdk/schema";
import { Downloader } from "@lando/sdk/services";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { resolveUserCacheRoot } from "../cache/paths";
import { ConfigServiceLive } from "../services/config";
import { EventServiceLive } from "../services/event-service";
import { updateOutcomeFromError } from "../telemetry/events";
import {
  UpdateDowngradeError,
  UpdateManifestReplayError,
  UpdateMinimumVersionError,
  UpdateNetworkError,
} from "./errors.ts";

export type UpdateManifestFetcher = (url: string) => Promise<Uint8Array>;

const UPDATE_BASE_URL = "https://update.lando.dev/v4";
export const updateManifestStatePath = (): string =>
  join(resolveUserCacheRoot(), "update-manifest-state.json");

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

export const platform = (): string => `${process.platform}-${process.arch}`;

interface UpdateHostPlatform {
  readonly platform: string;
  readonly arch: string;
}

export const updatePlatformId = (host: UpdateHostPlatform): string => `${host.platform}-${host.arch}`;

export const updateManifestPlatform = (
  host: UpdateHostPlatform = process,
): keyof UpdateManifest["binaries"] =>
  host.platform === "win32" ? "windows-x64" : (updatePlatformId(host) as keyof UpdateManifest["binaries"]);

export const isPlaceholderBinary = (
  binary: UpdateManifest["binaries"][keyof UpdateManifest["binaries"]],
): boolean => binary.size === 0 || binary.sha256 === "" || /^0+$/u.test(binary.sha256);

export const defaultFetchManifestBytes: UpdateManifestFetcher = (url) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "lando-update-fetch-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const downloader = yield* Downloader;
        const result = yield* downloader.download({
          url,
          destination: { kind: "file", directory, filename: "artifact" },
        });
        const bytes = yield* Effect.promise(() => readFile(result.path ?? join(directory, "artifact")));
        return new Uint8Array(bytes);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DownloaderLive.pipe(Layer.provide(HttpClientLive.pipe(Layer.provide(EventServiceLive)))),
            ConfigServiceLive,
          ),
        ),
      ),
    ),
  );

export const fetchBytes = (
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

export const parseJson = (bytes: Uint8Array, url: string): Effect.Effect<unknown, UpdateNetworkError> =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) =>
      new UpdateNetworkError({
        message: `Update manifest at ${url} is not valid JSON.`,
        url,
        cause,
      }),
  });

export const decodeManifest = (
  input: unknown,
  url: string,
): Effect.Effect<UpdateManifest, UpdateNetworkError> => {
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

export const compareVersions = (left: string, right: string): number => {
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

export const enforceMinimumVersion = (
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

export const enforceNoDowngrade = (
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

export const readUpdateManifestState = (
  path: string,
): Effect.Effect<UpdateManifestState, UpdateNetworkError> =>
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

export const writeUpdateManifestState = (
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

export const writeUpdateFailureState = ({
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

export const failureOutcomeFromError = (
  error: unknown,
): Exclude<ReturnType<typeof updateOutcomeFromError>, "success"> => {
  const outcome = updateOutcomeFromError(error);
  return outcome === "success" ? "network_failure" : outcome;
};

export const enforceManifestFreshness = (
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
