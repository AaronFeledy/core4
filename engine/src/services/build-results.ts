import type { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { StateBucket, StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";
import type { BuildOwner } from "./build-owner.ts";

export { BuildOwner } from "./build-owner.ts";

// Version 4 discards the former flat shape; no app receipt can carry artifact provenance.
const BUILD_RESULTS_VERSION = 4;
const KEEP_BUILD_KEYS = 5;
const KEEP_ENTRIES = 500;

const commonFields = {
  buildKey: Schema.String,
  service: ServiceName,
  outcome: Schema.Literals(["complete", "fail"]),
  durationMs: Schema.Number,
  transcriptPath: AbsolutePath,
  completedAt: Schema.DateTimeUtcFromString,
};

export const ArtifactBuildResult = Schema.Struct({
  ...commonFields,
  phase: Schema.Literal("artifact"),
  step: Schema.optionalKey(Schema.Never),
  containerId: Schema.optionalKey(Schema.Never),
  exitCode: Schema.optionalKey(Schema.Never),
  artifactRef: Schema.optionalKey(Schema.String),
  artifactDigest: Schema.optionalKey(Schema.String),
  /** `build` when the provider produced `artifactRef`; absent when the result is an acquired source ref. */
  artifactOrigin: Schema.optionalKey(Schema.Literal("build")),
  sourceArtifactRef: Schema.optionalKey(Schema.String),
  sourceArtifactDigest: Schema.optionalKey(Schema.String),
});
export type ArtifactBuildResult = typeof ArtifactBuildResult.Type;

export const AppBuildResult = Schema.Struct({
  ...commonFields,
  phase: Schema.Literal("app"),
  step: Schema.String,
  containerId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  artifactRef: Schema.optionalKey(Schema.Never),
  artifactDigest: Schema.optionalKey(Schema.Never),
  artifactOrigin: Schema.optionalKey(Schema.Never),
  sourceArtifactRef: Schema.optionalKey(Schema.Never),
  sourceArtifactDigest: Schema.optionalKey(Schema.Never),
});
export type AppBuildResult = typeof AppBuildResult.Type;
export const BuildResultEntry = Schema.Union([ArtifactBuildResult, AppBuildResult]);
export type BuildResultEntry = typeof BuildResultEntry.Type;

const BuildResultEntries = Schema.Array(BuildResultEntry);

export const openScratchBuildResults = (
  stateStore: StateStoreShape,
): Effect.Effect<StateBucket<ReadonlyArray<BuildResultEntry>>, StateStoreError> =>
  stateStore.open({
    root: "userCache",
    key: "scratch-build-results.bin",
    schema: BuildResultEntries,
    version: BUILD_RESULTS_VERSION,
    codec: "binary",
    lock: "advisory",
    onCorrupt: "quarantine",
    onVersionMismatch: "discard",
    default: [],
  });

export const openAppBuildResults = (
  stateStore: StateStoreShape,
  owner: BuildOwner,
): Effect.Effect<StateBucket<ReadonlyArray<BuildResultEntry>>, StateStoreError> =>
  stateStore.open({
    root: "userCache",
    namespace: "build-results-owned",
    key: `${owner.kind}-${owner.key}.bin`,
    schema: BuildResultEntries,
    version: BUILD_RESULTS_VERSION,
    codec: "binary",
    lock: "advisory",
    onCorrupt: "quarantine",
    onVersionMismatch: "discard",
    default: [],
  });

type ArtifactLookup = Pick<ArtifactBuildResult, "buildKey" | "service" | "phase">;
type AppLookup = Pick<AppBuildResult, "buildKey" | "service" | "phase" | "step"> & {
  readonly containerId: string | undefined;
};

export function findCompleteBuildResult(
  entries: ReadonlyArray<BuildResultEntry>,
  input: ArtifactLookup,
): ArtifactBuildResult | undefined;
export function findCompleteBuildResult(
  entries: ReadonlyArray<BuildResultEntry>,
  input: AppLookup,
): AppBuildResult | undefined;
export function findCompleteBuildResult(
  entries: ReadonlyArray<BuildResultEntry>,
  input: ArtifactLookup | AppLookup,
): BuildResultEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry !== undefined &&
      entry.buildKey === input.buildKey &&
      entry.phase === input.phase &&
      entry.service === input.service &&
      entry.step === (input.phase === "app" ? input.step : undefined)
    ) {
      // Only the latest recorded attempt counts: a newer failure hides an older success.
      if (entry.outcome !== "complete") return undefined;
      switch (input.phase) {
        case "artifact":
          return entry;
        case "app":
          return input.containerId !== undefined &&
            input.containerId.length > 0 &&
            entry.containerId === input.containerId
            ? entry
            : undefined;
      }
    }
  }
  return undefined;
}

/** Drop every app-phase entry; a build.app result only describes the container it ran in. */
export const clearAppBuildResults = Effect.fnUntraced(function* (
  stateStore: StateStoreShape,
  owner: BuildOwner,
): Effect.fn.Return<void, StateStoreError> {
  const bucket = yield* openAppBuildResults(stateStore, owner);
  yield* bucket.mutate((current) => {
    const entries = current ?? [];
    const kept = entries.filter((entry) => entry.phase !== "app");
    if (kept.length === entries.length) return Effect.succeed({ _tag: "Keep" as const, result: undefined });
    return Effect.succeed(
      kept.length === 0
        ? { _tag: "Remove" as const, result: undefined }
        : { _tag: "Set" as const, value: kept, result: undefined },
    );
  });
});

const identityOf = (entry: BuildResultEntry): string =>
  `${entry.service}\u0000${entry.phase}\u0000${entry.step ?? ""}`;

const resultKeyOf = (entry: BuildResultEntry): string => `${identityOf(entry)}\u0000${entry.buildKey}`;

/**
 * Apply the overall backstop without evicting a step's newest entry while it still has older keys:
 * an unchanged step's only entry may be the oldest entry recorded.
 */
const capBuildResults = (entries: ReadonlyArray<BuildResultEntry>): ReadonlyArray<BuildResultEntry> => {
  if (entries.length <= KEEP_ENTRIES) return entries;
  // `entries` is in recording order, so scanning backwards finds each identity's newest entry.
  const newest = new Set<string>();
  const identities = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const identity = identityOf(entry);
    if (identities.has(identity)) continue;
    identities.add(identity);
    newest.add(resultKeyOf(entry));
  }
  const excess = entries.length - KEEP_ENTRIES;
  const olderKeys = entries.filter((entry) => !newest.has(resultKeyOf(entry)));
  const dropped = new Set<string>();
  if (olderKeys.length >= excess) {
    for (const entry of olderKeys.slice(0, excess)) dropped.add(resultKeyOf(entry));
  } else {
    for (const entry of olderKeys) dropped.add(resultKeyOf(entry));
    // The newest entries alone exceed the cap: drop the least recently recorded of those.
    const newestEntries = entries.filter((entry) => newest.has(resultKeyOf(entry)));
    for (const entry of newestEntries.slice(0, excess - olderKeys.length)) {
      dropped.add(resultKeyOf(entry));
    }
  }
  return entries.filter((entry) => !dropped.has(resultKeyOf(entry)));
};

/**
 * One entry per (service, phase, step, buildKey): a re-run replaces that key's earlier attempt.
 * Each step identity keeps its five most recently recorded build keys; 500 entries is the backstop.
 */
const rotateBuildResults = (entries: ReadonlyArray<BuildResultEntry>): ReadonlyArray<BuildResultEntry> => {
  const latest = new Map<string, BuildResultEntry>();
  for (const entry of entries) {
    const key = resultKeyOf(entry);
    // Re-inserting moves the key to the end, so map order is recording order.
    latest.delete(key);
    latest.set(key, entry);
  }
  const keysByIdentity = new Map<string, string[]>();
  for (const entry of latest.values()) {
    const identity = identityOf(entry);
    const keys = keysByIdentity.get(identity);
    if (keys === undefined) keysByIdentity.set(identity, [entry.buildKey]);
    else keys.push(entry.buildKey);
  }
  const retained = new Set<string>();
  for (const [identity, keys] of keysByIdentity) {
    for (const buildKey of keys.slice(-KEEP_BUILD_KEYS)) retained.add(`${identity}\u0000${buildKey}`);
  }
  return capBuildResults([...latest.values()].filter((entry) => retained.has(resultKeyOf(entry))));
};

export const recordBuildResult = Effect.fnUntraced(function* (
  bucket: StateBucket<ReadonlyArray<BuildResultEntry>>,
  entry: Omit<AppBuildResult, "completedAt"> | Omit<ArtifactBuildResult, "completedAt">,
): Effect.fn.Return<void, StateStoreError> {
  const completedAt = yield* DateTime.now;
  yield* bucket.update((current) => rotateBuildResults([...(current ?? []), { ...entry, completedAt }]));
});

/**
 * Move a reused entry to the newest position of its step identity, under the bucket lock, so the next
 * rotation keeps it and `logs --build` prints the output that is actually in use. A hit that is
 * already newest writes nothing.
 */
export const markBuildResultUsed = Effect.fnUntraced(function* (
  bucket: StateBucket<ReadonlyArray<BuildResultEntry>>,
  used: BuildResultEntry,
): Effect.fn.Return<void, StateStoreError> {
  yield* bucket.mutate((current) => {
    const entries = current ?? [];
    const key = resultKeyOf(used);
    const index = entries.findIndex((entry) => resultKeyOf(entry) === key);
    const moved = index === -1 ? undefined : entries[index];
    if (moved === undefined) return Effect.succeed({ _tag: "Keep" as const, result: undefined });
    const identity = identityOf(used);
    let newest = -1;
    for (let position = entries.length - 1; position >= 0; position -= 1) {
      const entry = entries[position];
      if (entry !== undefined && identityOf(entry) === identity) {
        newest = position;
        break;
      }
    }
    if (newest === index) return Effect.succeed({ _tag: "Keep" as const, result: undefined });
    return Effect.succeed({
      _tag: "Set" as const,
      value: [...entries.slice(0, index), ...entries.slice(index + 1), moved],
      result: undefined,
    });
  });
});
