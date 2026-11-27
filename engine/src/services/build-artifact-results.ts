import { isErrnoCode } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { StateBucket, StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";
import type { BuildOwner } from "./build-owner.ts";

export const ArtifactBuildResult = Schema.Struct({
  owner: Schema.String,
  providerId: Schema.String,
  phase: Schema.Literal("artifact"),
  step: Schema.optionalKey(Schema.Never),
  containerId: Schema.optionalKey(Schema.Never),
  invalidated: Schema.optionalKey(Schema.Never),
  exitCode: Schema.optionalKey(Schema.Never),
  service: ServiceName,
  buildKey: Schema.String,
  artifactRef: Schema.String,
  artifactDigest: Schema.optionalKey(Schema.String),
  sourceArtifactRef: Schema.optionalKey(Schema.String),
  sourceArtifactDigest: Schema.optionalKey(Schema.String),
  artifactOrigin: Schema.optionalKey(Schema.Literal("build")),
  outcome: Schema.Literals(["complete", "fail"]),
  durationMs: Schema.Number,
  transcriptPath: AbsolutePath,
  completedAt: Schema.DateTimeUtcFromString,
  releasedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type ArtifactBuildResult = typeof ArtifactBuildResult.Type;
export const ArtifactBuildClaim = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  artifactRef: Schema.String,
  pid: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
  ),
  claimedAt: Schema.DateTimeUtcFromString,
});
export type ArtifactBuildClaim = typeof ArtifactBuildClaim.Type;
export const ArtifactBuildIndex = Schema.Struct({
  results: Schema.Array(ArtifactBuildResult),
  claims: Schema.Array(ArtifactBuildClaim),
});
export type ArtifactBuildIndex = typeof ArtifactBuildIndex.Type;
export type ArtifactResultsBucket = StateBucket<ArtifactBuildIndex>;
export const openArtifactBuildResults = (store: StateStoreShape, mode: "manage" | "observe" = "manage") =>
  store.open({
    root: "userCache",
    key: "artifact-build-results.bin",
    schema: ArtifactBuildIndex,
    version: 2,
    codec: "binary",
    lock: "advisory",
    onCorrupt: mode === "observe" ? "discard" : "quarantine",
    ...(mode === "observe" ? {} : { onVersionMismatch: "discard" as const }),
    default: { results: [], claims: [] },
  });

/** A reused pid conservatively retains a claim; only an absent process releases it. */
export const artifactClaimIsAlive = (claim: ArtifactBuildClaim): boolean => {
  try {
    process.kill(claim.pid, 0);
    return true;
  } catch (cause) {
    return !isErrnoCode(cause, "ESRCH");
  }
};
const identity = (entry: ArtifactBuildResult): string =>
  `${entry.owner}\0${entry.providerId}\0${entry.service}`;
const key = (entry: ArtifactBuildResult): string => `${identity(entry)}\0${entry.buildKey}`;
const empty: ArtifactBuildIndex = { results: [], claims: [] };
const RELEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Results are in last-use order. Only the writing owner's active history rotates. */
export const rotateArtifactBuildResults = (
  entries: readonly ArtifactBuildResult[],
  owner: string,
  now: DateTime.Utc,
) => {
  const counts = new Map<string, number>();
  const newest = new Set<string>();
  const retained = new Set<ArtifactBuildResult>();
  const released = new Set(
    entries
      .filter(
        (entry) =>
          entry.releasedAt !== undefined &&
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(entry.releasedAt) <= RELEASE_RETENTION_MS,
      )
      .toReversed()
      .sort(
        (a, b) =>
          DateTime.toEpochMillis(b.releasedAt ?? b.completedAt) -
          DateTime.toEpochMillis(a.releasedAt ?? a.completedAt),
      )
      .slice(0, 10),
  );
  for (const entry of entries.toReversed()) {
    const id = identity(entry);
    if (entry.releasedAt !== undefined) {
      if (released.has(entry)) retained.add(entry);
      continue;
    }
    const count = counts.get(id) ?? 0;
    if (count === 0) newest.add(key(entry));
    counts.set(id, count + 1);
    if (entry.owner !== owner || count < 5) retained.add(entry);
  }
  let excess = retained.size - 2000;
  for (const entry of entries) {
    if (excess <= 0) break;
    if (entry.owner === owner && retained.has(entry) && !newest.has(key(entry))) {
      retained.delete(entry);
      excess -= 1;
    }
  }
  return {
    entries: entries.filter((entry) => retained.has(entry)),
    dropped: entries.filter((entry) => !retained.has(entry)),
  };
};

const writeIndex = (current: ArtifactBuildIndex, results: readonly ArtifactBuildResult[]) => ({
  results,
  claims: current.claims.filter(artifactClaimIsAlive),
});
export const recordArtifactBuildResult = Effect.fnUntraced(function* (
  bucket: ArtifactResultsBucket,
  entry: Omit<ArtifactBuildResult, "completedAt">,
) {
  const completedAt = yield* DateTime.now;
  return yield* bucket.modify((current) => {
    const previous = current ?? empty;
    const next = { ...entry, completedAt };
    const replaced = previous.results.filter((item) => key(item) === key(next));
    const rotated = rotateArtifactBuildResults(
      [...previous.results.filter((item) => key(item) !== key(next)), next],
      entry.owner,
      completedAt,
    );
    return [[...replaced, ...rotated.dropped], writeIndex(previous, rotated.entries)] as const;
  });
});

export const claimArtifactBuild = Effect.fnUntraced(function* (
  bucket: ArtifactResultsBucket,
  claim: Pick<ArtifactBuildClaim, "providerId" | "artifactRef">,
) {
  const claimedAt = yield* DateTime.now;
  const next = { ...claim, id: crypto.randomUUID(), pid: process.pid, claimedAt };
  const dropped = yield* bucket.modify((current) => {
    const previous = current ?? empty;
    const rotated = rotateArtifactBuildResults(previous.results, "", claimedAt);
    return [
      rotated.dropped,
      { results: rotated.entries, claims: [...previous.claims.filter(artifactClaimIsAlive), next] },
    ] as const;
  });
  return { claim: next, dropped };
});
export const settleArtifactBuildClaim = Effect.fnUntraced(function* (
  bucket: ArtifactResultsBucket,
  id: string,
) {
  const now = yield* DateTime.now;
  return yield* bucket.modify((current) => {
    const previous = current ?? empty;
    const rotated = rotateArtifactBuildResults(previous.results, "", now);
    return [
      rotated.dropped,
      {
        results: rotated.entries,
        claims: previous.claims.filter((claim) => claim.id !== id && artifactClaimIsAlive(claim)),
      },
    ] as const;
  });
});

const findArtifactBuildResult = (
  entries: readonly ArtifactBuildResult[],
  lookup: Pick<ArtifactBuildResult, "owner" | "providerId" | "service" | "buildKey">,
  now: DateTime.Utc,
) => {
  const matches = entries.filter(
    (entry) =>
      entry.providerId === lookup.providerId &&
      entry.service === lookup.service &&
      entry.buildKey === lookup.buildKey &&
      entry.outcome === "complete" &&
      (entry.releasedAt === undefined ||
        DateTime.toEpochMillis(now) - DateTime.toEpochMillis(entry.releasedAt) <= RELEASE_RETENTION_MS),
  );
  return matches.findLast((entry) => entry.owner === lookup.owner) ?? matches.at(-1);
};
/** Caller holds the operation lock through verification and adoption, excluding the sweep. */
export const useArtifactBuildResult = Effect.fnUntraced(function* <E = never>(
  bucket: ArtifactResultsBucket,
  lookup: Pick<ArtifactBuildResult, "owner" | "providerId" | "service" | "buildKey">,
  validate?: (entry: ArtifactBuildResult) => Effect.Effect<boolean, E>,
) {
  const now = yield* DateTime.now;
  return yield* bucket.mutate<
    { readonly entry: ArtifactBuildResult; readonly dropped: readonly ArtifactBuildResult[] } | undefined,
    E
  >((current) =>
    Effect.gen(function* () {
      const previous = current ?? empty;
      const entry = findArtifactBuildResult(previous.results, lookup, now);
      if (entry === undefined || (validate !== undefined && !(yield* validate(entry))))
        return { _tag: "Keep" as const, result: undefined };
      const { releasedAt: _, ...active } = entry;
      const used: ArtifactBuildResult = { ...active, owner: lookup.owner, completedAt: now };
      const replaced = previous.results.filter((item) => item !== entry && key(item) === key(used));
      const results = previous.results.filter(
        (item) =>
          key(item) !== key(used) &&
          (item !== entry || (entry.owner !== lookup.owner && entry.releasedAt === undefined)),
      );
      const rotated = rotateArtifactBuildResults([...results, used], lookup.owner, now);
      return {
        _tag: "Set" as const,
        result: { entry: used, dropped: [...replaced, ...rotated.dropped] },
        value: writeIndex(previous, rotated.entries),
      };
    }),
  );
});

export const removeArtifactBuildResults = Effect.fnUntraced(function* (
  bucket: ArtifactResultsBucket,
  owner: BuildOwner,
  options: { readonly providerId?: string; readonly images: "release" | "remove" },
) {
  const now = yield* DateTime.now;
  return yield* bucket.modify((current) => {
    const previous = current ?? empty;
    const affected = previous.results.filter(
      (entry) =>
        entry.owner === owner.key &&
        (options.providerId === undefined || entry.providerId === options.providerId),
    );
    const latest = new Map<string, ArtifactBuildResult>();
    if (options.images === "release")
      for (const entry of affected) {
        if (entry.outcome === "complete" && entry.artifactOrigin === "build")
          latest.set(`${entry.providerId}\0${entry.service}`, entry);
      }
    const affectedSet = new Set(affected);
    const released = [...latest.values()].map((entry) => ({ ...entry, releasedAt: now }));
    const rotated = rotateArtifactBuildResults(
      [...previous.results.filter((entry) => !affectedSet.has(entry)), ...released],
      owner.key,
      now,
    );
    const retained = new Set(rotated.entries);
    const retainedReleased = released.filter((entry) => retained.has(entry));
    return [
      {
        providerIds: [...new Set([...affected, ...rotated.dropped].map((entry) => entry.providerId))],
        released: retainedReleased.length,
        releasedOwners: retainedReleased.map((entry) => `${entry.owner}\0${entry.providerId}`),
      },
      writeIndex(previous, rotated.entries),
    ] as const;
  });
});
