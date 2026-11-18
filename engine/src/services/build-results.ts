import { ProviderInternalError, type StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { StateBucket, StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";
import type { BuildOwner } from "./build-owner.ts";

export { BuildOwner } from "./build-owner.ts";

export const buildResultsError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the build-results cache.",
    cause,
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
  });

const BUILD_RESULTS_VERSION = 5;
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

import { ArtifactBuildResult } from "./build-artifact-results.ts";

export { ArtifactBuildResult } from "./build-artifact-results.ts";

export const AppBuildResult = Schema.Struct({
  ...commonFields,
  phase: Schema.Literal("app"),
  step: Schema.String,
  containerId: Schema.optionalKey(Schema.String),
  invalidated: Schema.optionalKey(Schema.Literal(true)),
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

const BuildResultEntries = Schema.Array(AppBuildResult);

export const openAppBuildResults = (
  stateStore: StateStoreShape,
  owner: BuildOwner,
): Effect.Effect<StateBucket<ReadonlyArray<AppBuildResult>>, StateStoreError> =>
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

type AppLookup = Pick<AppBuildResult, "buildKey" | "service" | "phase" | "step"> & {
  readonly containerId: string | undefined;
};

export const invalidateAppBuildResult = (
  bucket: StateBucket<ReadonlyArray<AppBuildResult>>,
  input: AppLookup,
): Effect.Effect<void, StateStoreError> =>
  bucket.mutate((current) => {
    const entries = current ?? [];
    const updated = entries.map((entry) =>
      identityOf(entry) === identityOf(input) && entry.outcome === "complete" && !entry.invalidated
        ? { ...entry, invalidated: true as const }
        : entry,
    );
    return Effect.succeed(
      updated.every((entry, index) => entry === entries[index])
        ? { _tag: "Keep" as const, result: undefined }
        : { _tag: "Set" as const, value: updated, result: undefined },
    );
  });

export function findCompleteBuildResult(
  entries: ReadonlyArray<AppBuildResult>,
  input: AppLookup,
): AppBuildResult | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && identityOf(entry) === identityOf(input)) {
      // Only the latest recorded attempt counts: a newer failure hides an older success.
      if (entry.outcome !== "complete" || entry.buildKey !== input.buildKey) return undefined;
      return !entry.invalidated && input.containerId && entry.containerId === input.containerId
        ? entry
        : undefined;
    }
  }
  return undefined;
}

export const clearAppBuildResults = Effect.fnUntraced(function* (
  stateStore: StateStoreShape,
  owner: BuildOwner,
): Effect.fn.Return<void, StateStoreError> {
  const bucket = yield* openAppBuildResults(stateStore, owner);
  yield* bucket.remove;
});

type BuildResultIdentity = Pick<AppBuildResult, "service" | "phase" | "step" | "buildKey">;
const identityOf = (entry: BuildResultIdentity): string =>
  `${entry.service}\u0000${entry.phase}\u0000${entry.step}`;

const resultKeyOf = (entry: BuildResultIdentity): string => `${identityOf(entry)}\u0000${entry.buildKey}`;

/**
 * Apply the overall backstop without evicting a step's newest entry while it still has older keys:
 * an unchanged step's only entry may be the oldest entry recorded.
 */
const capBuildResults = (entries: ReadonlyArray<AppBuildResult>): ReadonlyArray<AppBuildResult> => {
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
const rotateBuildResults = (entries: ReadonlyArray<AppBuildResult>): ReadonlyArray<AppBuildResult> => {
  const latest = new Map<string, AppBuildResult>();
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
  bucket: StateBucket<ReadonlyArray<AppBuildResult>>,
  entry: Omit<AppBuildResult, "completedAt">,
): Effect.fn.Return<void, StateStoreError> {
  const completedAt = yield* DateTime.now;
  yield* bucket.update((current) => rotateBuildResults([...(current ?? []), { ...entry, completedAt }]));
});

/**
 * Move a reused entry to the newest position of its step identity, under the bucket lock, so the next
 * rotation keeps it and `logs --build` prints the output that is actually in use. A hit that is
 * already newest writes nothing.
 */
export const markBuildResultUsed = (
  bucket: StateBucket<ReadonlyArray<AppBuildResult>>,
  used: AppBuildResult,
): Effect.Effect<void, StateStoreError> =>
  bucket.mutate((current) => {
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
