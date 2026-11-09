/** Update manifest location, decoding, version policy, and freshness state. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";

import { Cause, Context, Effect, Exit, Layer, Option, Result, Schema } from "effect";

import { layer as downloaderLayer } from "@lando/http-client/downloader";
import { layer as httpClientLayer } from "@lando/http-client/live";
import { DownloadFetchError, StateStoreError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type UpdateChannel,
  type UpdateManifestSchema as UpdateManifest,
  UpdateManifestSchema,
  UpdateManifestSemver,
} from "@lando/sdk/schema";
import { Downloader, StateStore, type StateWrite } from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";
import { updateOutcomeFromError } from "@lando/telemetry/events";
import { resolveUserDataRoot } from "../config/roots";
import * as LandoEventService from "../services/event-service";
import {
  UpdateDowngradeError,
  UpdateManifestReplayError,
  UpdateMinimumVersionError,
  UpdateNetworkError,
} from "./errors.ts";
import { PluginUpdatePlanRowSchema } from "./plugin-plan.ts";

export type UpdateManifestFetcher = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

import { CoreUpdateFailureSchema } from "./errors.ts";

export const UpdateResultSchema = Schema.Struct({
  coreReplacementPending: Schema.optionalKey(Schema.Boolean),
  coreFailure: Schema.optionalKey(CoreUpdateFailureSchema),
  updatedCore: Schema.Boolean,
  updatedPlugins: Schema.Array(Schema.String),
  pluginResults: Schema.optionalKey(Schema.Array(PluginUpdatePlanRowSchema)),
  hasFailures: Schema.optionalKey(Schema.Boolean),
  coreBlocked: Schema.optionalKey(Schema.Boolean),
  coreUpdateAvailable: Schema.optionalKey(Schema.Boolean),
});

const UPDATE_BASE_URL = "https://update.lando.dev/v4";
export const updateManifestStatePath = (): string =>
  join(resolveUserDataRoot(), "update-manifest-state.json");

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
  if (identifier === "dev") return "dev";
  if (identifier === "next" || identifier === "rc") return "next";
  return "stable";
};

export const platform = (): string => `${process.platform}-${process.arch}`;

interface UpdateHostPlatform {
  readonly platform: string;
  readonly arch: string;
}

export const updatePlatformId = (host: UpdateHostPlatform): string => `${host.platform}-${host.arch}`;

/**
 * Map the running host onto a published update-manifest binary key.
 * Every win32 host, including win32-arm64, still uses `windows-x64`
 * because the published 5-key schema has no windows-arm64 entry.
 * `lando update` on windows-arm64 therefore still downloads windows-x64.
 */
export const updateManifestPlatform = (
  host: UpdateHostPlatform = process,
): keyof UpdateManifest["binaries"] =>
  host.platform === "win32" ? "windows-x64" : (updatePlatformId(host) as keyof UpdateManifest["binaries"]);

export const isPlaceholderBinary = (
  binary: UpdateManifest["binaries"][keyof UpdateManifest["binaries"]],
): boolean => binary.size === 0 || binary.sha256 === "" || /^0+$/u.test(binary.sha256);

export const defaultFetchManifestBytes = (
  url: string,
  retainedDownloader?: typeof Downloader.Service,
  requestContext: Context.Context<never> = Context.empty(),
  signal?: AbortSignal,
): Promise<Uint8Array> =>
  Effect.runPromiseExit(
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
          retainedDownloader === undefined
            ? downloaderLayer.pipe(
                Layer.provide(httpClientLayer.pipe(Layer.provide(LandoEventService.layer))),
              )
            : Layer.succeed(Downloader, retainedDownloader),
        ),
        Effect.provide(requestContext),
      ),
    ),
    { signal },
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  });

export const fetchBytes = (
  fetcher: UpdateManifestFetcher,
  url: string,
): Effect.Effect<Uint8Array, UpdateNetworkError> =>
  Effect.tryPromise({
    try: (signal) => fetcher(url, signal),
    catch: (cause) =>
      new UpdateNetworkError({
        message:
          cause instanceof DownloadFetchError
            ? cause.message
            : `Failed to download ${url} for \`lando update\`.`,
        url,
        remediation:
          cause instanceof DownloadFetchError
            ? `${cause.remediation} Then run \`lando update\` again.`
            : `Check network access to ${url}, then retry \`lando update\`.`,
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
        remediation:
          "Confirm the update channel URL returns a Lando update manifest, then retry `lando update`.",
        cause,
      }),
  });

export const decodeManifest = (
  input: unknown,
  url: string,
): Effect.Effect<UpdateManifest, UpdateNetworkError> => {
  const decoded = Schema.decodeUnknownResult(UpdateManifestSchema)(input, { onExcessProperty: "error" });
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        new UpdateNetworkError({
          message: `Update manifest at ${url} failed schema validation.`,
          url,
          remediation:
            "Use a channel that publishes a current Lando update manifest schema, then retry `lando update`.",
          cause: decoded.failure,
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

const UpdateFailureCategorySchema = Schema.Literals([
  "signature_failure",
  "launch_probe_failure",
  "permission_failure",
  "network_failure",
]);

// The floor is a security record: a key it doesn't define (a misspelled channel, a field from
// another build) must fail the read instead of decoding to an empty, lowerable floor.
const knownKeysOnly = <S extends Schema.Top>(schema: S, keys: ReadonlyArray<string>) =>
  Schema.Unknown.check(
    Schema.makeFilter(
      (input: unknown) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).every((key) => keys.includes(key)),
      { expected: `an object with only ${keys.join(", ")}` },
    ),
  ).pipe(Schema.decodeTo(schema));

const UpdateManifestFailureSchema = Schema.Struct({
  category: UpdateFailureCategorySchema,
  targetVersion: UpdateManifestSemver,
  platform: Schema.String,
});

const UpdateManifestChannelEntryFields = Schema.Struct({
  latest: UpdateManifestSemver,
  lastFailure: Schema.optionalKey(
    knownKeysOnly(UpdateManifestFailureSchema, ["category", "targetVersion", "platform"]),
  ),
});
const UpdateManifestChannelEntrySchema = knownKeysOnly(UpdateManifestChannelEntryFields, [
  "latest",
  "lastFailure",
]).check(
  Schema.makeFilter(
    (entry) =>
      entry.lastFailure === undefined || compareVersions(entry.lastFailure.targetVersion, entry.latest) <= 0,
    { expected: "a last failure target at or below the observed version floor" },
  ),
);
type UpdateManifestStateEntry = typeof UpdateManifestChannelEntryFields.Type;

export const UpdateManifestStateSchema = knownKeysOnly(
  Schema.Struct({
    stable: Schema.optionalKey(UpdateManifestChannelEntrySchema),
    next: Schema.optionalKey(UpdateManifestChannelEntrySchema),
    dev: Schema.optionalKey(UpdateManifestChannelEntrySchema),
  }),
  ["stable", "next", "dev"],
);
type UpdateManifestState = typeof UpdateManifestStateSchema.Type;

const LegacyUpdateManifestStateSchema = knownKeysOnly(
  Schema.Struct({
    stable: Schema.optionalKey(knownKeysOnly(UpdateManifestChannelEntryFields, ["latest", "lastFailure"])),
    next: Schema.optionalKey(knownKeysOnly(UpdateManifestChannelEntryFields, ["latest", "lastFailure"])),
    dev: Schema.optionalKey(knownKeysOnly(UpdateManifestChannelEntryFields, ["latest", "lastFailure"])),
  }),
  ["stable", "next", "dev"],
);

export const UPDATE_MANIFEST_STATE_VERSION = 2;
const emptyUpdateManifestState: UpdateManifestState = {};

const normalizeUpdateManifestState = (state: UpdateManifestState | null | undefined): UpdateManifestState => {
  if (state === null || state === undefined) return emptyUpdateManifestState;
  return {
    ...(state.stable === undefined ? {} : { stable: state.stable }),
    ...(state.next === undefined ? {} : { next: state.next }),
    ...(state.dev === undefined ? {} : { dev: state.dev }),
  };
};

/** Observation-derived monotonic register, not a finite lifecycle. Every writer
 * merges under the bucket's advisory lock: latest never falls. lastFailure is
 * the last recorded attempt (including delayed older attempts), not current
 * health; success retains it. Its target cannot exceed latest. Admission reads
 * latest only. Migration also uses this merge, conservatively raising old floors.
 */
const mergeChannelLatest = (
  current: UpdateManifestStateEntry | undefined,
  candidateLatest: string,
  lastFailure?: UpdateManifestStateEntry["lastFailure"],
): UpdateManifestStateEntry => {
  const latest =
    current?.latest !== undefined && compareVersions(current.latest, candidateLatest) > 0
      ? current.latest
      : candidateLatest;
  const failure = lastFailure !== undefined ? lastFailure : current?.lastFailure;
  return failure === undefined ? { latest } : { latest, lastFailure: failure };
};

const mergeChannel = (
  current: UpdateManifestState | null,
  channel: UpdateChannel,
  candidateLatest: string,
  lastFailure?: UpdateManifestStateEntry["lastFailure"],
): UpdateManifestState => {
  const state = normalizeUpdateManifestState(current);
  return { ...state, [channel]: mergeChannelLatest(state[channel], candidateLatest, lastFailure) };
};

const manifestReplayError = (channel: UpdateChannel, cachedVersion: string, manifestVersion: string) =>
  new UpdateManifestReplayError({
    message: `Update manifest ${channel} channel version ${manifestVersion} is older than previously observed signed version ${cachedVersion}. Refusing possible manifest replay.`,
    channel,
    cachedVersion,
    manifestVersion,
    remediation:
      "Use a trusted channel whose signed manifest is at least as new as the last verified version; wait for a newer signed release and retry `lando update` without disabling freshness checks.",
  });

const freshnessCorruptError = (path: string, cause: unknown): UpdateNetworkError =>
  new UpdateNetworkError({
    message: `Update manifest freshness state at ${path} failed schema validation.`,
    url: path,
    remediation: `Remove the corrupt freshness file at ${path}, then retry \`lando update\`.`,
    cause,
  });

const freshnessIoError = (path: string, operation: "read" | "write", cause: unknown): UpdateNetworkError =>
  operation === "read"
    ? new UpdateNetworkError({
        message: `Failed to read update manifest freshness state at ${path}.`,
        url: path,
        remediation: `Fix permissions on ${path} or remove the corrupt freshness file, then retry \`lando update\`.`,
        cause,
      })
    : new UpdateNetworkError({
        message: `Failed to write update manifest freshness state at ${path}.`,
        url: path,
        remediation: `Ensure the parent of ${path} is writable, then retry \`lando update\`.`,
        cause,
      });

const mapFreshnessStoreError = (path: string, cause: StateStoreError): UpdateNetworkError => {
  if (cause.reason === "decode" || cause.reason === "version") return freshnessCorruptError(path, cause);
  return freshnessIoError(
    path,
    cause.operation === "set" || cause.operation === "update" || cause.operation === "mutate"
      ? "write"
      : "read",
    cause,
  );
};

const updateManifestStateBucketSpec = (statePath: string) =>
  ({
    root: { path: AbsolutePath.make(dirname(statePath)) },
    key: basename(statePath),
    schema: UpdateManifestStateSchema,
    version: UPDATE_MANIFEST_STATE_VERSION,
    codec: "json" as const,
    mode: 0o600,
    lock: "advisory" as const,
    onCorrupt: "fail" as const,
    // Migration preserves both observations; unknown versions still fail closed.
    onVersionMismatch: (raw: unknown, fromVersion: number): UpdateManifestState => {
      if (fromVersion === 1) {
        const legacy = Schema.decodeUnknownSync(LegacyUpdateManifestStateSchema)(raw);
        return Schema.decodeUnknownSync(UpdateManifestStateSchema)(
          Object.fromEntries(
            (["stable", "next", "dev"] as const).flatMap((channel) => {
              const entry = legacy[channel];
              return entry === undefined
                ? []
                : [[channel, mergeChannelLatest(entry, entry.lastFailure?.targetVersion ?? entry.latest)]];
            }),
          ),
        );
      }
      throw new StateStoreError({
        reason: "version",
        operation: "get",
        path: statePath,
        remediation: `Unsupported update manifest freshness state version ${fromVersion}; remove the corrupt freshness file.`,
      });
    },
    default: emptyUpdateManifestState,
  }) as const;

const withDefaultStateStore = <A, E>(body: Effect.Effect<A, E, StateStore>): Effect.Effect<A, E> =>
  Effect.serviceOption(StateStore).pipe(
    Effect.flatMap((option) =>
      Option.isSome(option)
        ? body.pipe(Effect.provideService(StateStore, option.value))
        : body.pipe(Effect.provide(StateStoreLayer.layer)),
    ),
  );

const openUpdateManifestStateBucket = (statePath: string) =>
  withDefaultStateStore(
    Effect.gen(function* () {
      const store = yield* StateStore;
      return yield* store.open(updateManifestStateBucketSpec(statePath));
    }),
  );

export const readUpdateManifestState = (
  path: string,
): Effect.Effect<UpdateManifestState, UpdateNetworkError> =>
  openUpdateManifestStateBucket(path).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((state) => normalizeUpdateManifestState(state)),
    mapFailures((cause) => mapFreshnessStoreError(path, cause)),
  );

/** Merge a verified channel floor without ever lowering `latest`; preserves other channels. */
export const recordUpdateManifestSuccess = Effect.fn("Update.recordUpdateManifestSuccess")(function* (
  path: string,
  channel: UpdateChannel,
  latest: string,
): Effect.fn.Return<void, UpdateNetworkError> {
  yield* openUpdateManifestStateBucket(path).pipe(
    Effect.flatMap((bucket) => bucket.update((current) => mergeChannel(current, channel, latest))),
    Effect.asVoid,
    mapFailures((cause) => mapFreshnessStoreError(path, cause)),
  );
});

export const writeUpdateFailureState = Effect.fn("Update.writeUpdateFailureState")(function* ({
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
}): Effect.fn.Return<void, never> {
  // Best effort: never substitute `{}` after a failed read (corruption/io). Skip the write entirely.
  yield* openUpdateManifestStateBucket(path).pipe(
    Effect.flatMap((bucket) =>
      bucket.update((current) =>
        mergeChannel(current, channel, targetVersion, { category, targetVersion, platform }),
      ),
    ),
    Effect.catch(() => Effect.void),
  );
});

export const failureOutcomeFromError = (
  error: unknown,
): Exclude<ReturnType<typeof updateOutcomeFromError>, "success"> => {
  const outcome = updateOutcomeFromError(error);
  return outcome === "success" ? "network_failure" : outcome;
};

export const enforceManifestFreshness = Effect.fn("Update.enforceManifestFreshness")(function* (
  manifest: UpdateManifest,
  statePath: string,
  options: { readonly persist: boolean },
): Effect.fn.Return<void, UpdateNetworkError | UpdateManifestReplayError> {
  if (!options.persist) {
    const cached = (yield* readUpdateManifestState(statePath))[manifest.channel];
    if (cached !== undefined && compareVersions(manifest.latest, cached.latest) < 0)
      return yield* Effect.fail(manifestReplayError(manifest.channel, cached.latest, manifest.latest));
    return;
  }

  // Compare-and-advance under one advisory lock; a replay fails before anything is written.
  yield* openUpdateManifestStateBucket(statePath).pipe(
    Effect.flatMap((bucket) =>
      bucket.mutate((current) => {
        const cached = normalizeUpdateManifestState(current)[manifest.channel];
        return cached !== undefined && compareVersions(manifest.latest, cached.latest) < 0
          ? Effect.fail(manifestReplayError(manifest.channel, cached.latest, manifest.latest))
          : Effect.succeed<StateWrite<UpdateManifestState, void>>({
              _tag: "Set",
              value: mergeChannel(current, manifest.channel, manifest.latest),
              result: undefined,
            });
      }),
    ),
    Effect.catchTag("StateStoreError", (cause) => Effect.fail(mapFreshnessStoreError(statePath, cause))),
  );
});
