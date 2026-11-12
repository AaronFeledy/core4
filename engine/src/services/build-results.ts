import type { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { StateBucket, StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";

// Version 2 records `artifactOrigin`; version 1 entries cannot tell a produced image from an acquired
// source ref. Version 3 follows transcript redaction: entries recorded earlier can point at transcripts
// that were written unredacted, so they are discarded and their steps run once more.
const BUILD_RESULTS_VERSION = 3;
const KEEP_BUILD_KEYS = 5;
const KEEP_ENTRIES = 500;

export const BuildResultEntry = Schema.Struct({
  buildKey: Schema.String,
  service: ServiceName,
  phase: Schema.Literals(["artifact", "app"]),
  /** `BuildStep.id` for an app step; absent for an artifact step. */
  step: Schema.optionalKey(Schema.String),
  outcome: Schema.Literals(["complete", "fail"]),
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  artifactRef: Schema.optionalKey(Schema.String),
  artifactDigest: Schema.optionalKey(Schema.String),
  /** `build` when the provider produced `artifactRef`; absent when the result is an acquired source ref. */
  artifactOrigin: Schema.optionalKey(Schema.Literal("build")),
  sourceArtifactRef: Schema.optionalKey(Schema.String),
  sourceArtifactDigest: Schema.optionalKey(Schema.String),
  transcriptPath: AbsolutePath,
  completedAt: Schema.DateTimeUtcFromString,
});
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
  appId: string,
): Effect.Effect<StateBucket<ReadonlyArray<BuildResultEntry>>, StateStoreError> =>
  stateStore.open({
    root: "userCache",
    namespace: "build-results",
    key: `${appId}.bin`,
    schema: BuildResultEntries,
    version: BUILD_RESULTS_VERSION,
    codec: "binary",
    lock: "advisory",
    onCorrupt: "quarantine",
    onVersionMismatch: "discard",
    default: [],
  });

export const findCompleteBuildResult = (
  entries: ReadonlyArray<BuildResultEntry>,
  input: Pick<BuildResultEntry, "buildKey" | "phase" | "service"> & { readonly step?: string },
): BuildResultEntry | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry !== undefined &&
      entry.buildKey === input.buildKey &&
      entry.phase === input.phase &&
      entry.service === input.service &&
      entry.step === input.step
    ) {
      // Only the latest recorded attempt counts: a newer failure hides an older success.
      return entry.outcome === "complete" ? entry : undefined;
    }
  }
  return undefined;
};

/** Drop every app-phase entry; a build.app result only describes the container it ran in. */
export const clearAppBuildResults = Effect.fnUntraced(function* (
  stateStore: StateStoreShape,
  appId: string,
): Effect.fn.Return<void, StateStoreError> {
  const bucket = yield* openAppBuildResults(stateStore, appId);
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
  entry: Omit<BuildResultEntry, "completedAt">,
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
