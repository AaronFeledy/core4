import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { isErrnoCode } from "@lando/sdk/errors";
import type { StateBucket, StateStoreShape } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { acquisitionError } from "./errors.ts";

/** Publication is observed from the atomic directory namespace, not a stored
 * phase: a complete entry is reusable only at its content-addressed path.
 * Staging/replaced paths never claim to be the current publication. Repair
 * re-observes the tree under the store lock; GC alone retires it.
 */
export const EntryRecord = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["git", "archive"]),
  id: Schema.String,
  format: Schema.Literal(1),
  treeDigest: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u)),
  provenance: Schema.Struct({ source: Schema.String }),
}).check(
  Schema.makeFilter(
    (record) => (record.kind === "git" ? /^[a-f\d]{40}$/u : /^[a-f\d]{64}$/u).test(record.id),
    { expected: "a content identity matching the entry kind" },
  ),
);
export type EntryRecord = typeof EntryRecord.Type;
export const NpmIndexRecord = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  registry: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u)),
  integrity: Schema.optionalKey(Schema.String),
  shasum: Schema.optionalKey(Schema.String),
});
export const RefRecord = Schema.Struct({ commit: Schema.String.check(Schema.isPattern(/^[a-f\d]{40}$/u)) });
export const RootRecord = Schema.Struct({ lockfile: Schema.String, updatedAt: Schema.Number });

/**
 * Physical source-store root: dirname of any StateStore bucket under the
 * userCache `sources` namespace. One owner — callers never pass a separate root.
 */
export const resolveSourcesStoreRoot = (state: StateStoreShape) =>
  state
    .open({
      root: "userCache",
      namespace: "sources",
      // Probe only; never written. dirname(path) is the store root for entries/leases/GC.
      key: "root-probe",
      schema: Schema.NullOr(RootRecord),
      default: null,
      version: 1,
      onCorrupt: "discard",
    })
    .pipe(
      Effect.map((bucket) => dirname(bucket.path)),
      mapFailures((error) => acquisitionError("cache", "source store", error)),
    );

const regularRecord = <A>(bucket: StateBucket<A>) => {
  const regular = Effect.tryPromise({
    try: async () => {
      try {
        const stats = await lstat(bucket.path);
        return stats.isFile() && !stats.isSymbolicLink();
      } catch (cause) {
        if (isErrnoCode(cause, "ENOENT")) return false;
        throw cause;
      }
    },
    catch: (cause) => acquisitionError("cache", "source record", cause),
  });
  return {
    ...bucket,
    get: regular.pipe(Effect.flatMap((safe) => (safe ? bucket.get : Effect.succeed(null)))),
    exists: regular,
  };
};

/**
 * StateStore namespaces are single path segments (no `/`). Fold the logical
 * hierarchy into the key so buckets stay under userCache without nested dirs.
 */
export const sourceRecords = (state: StateStoreShape) => ({
  npm: (registry: string, name: string, version: string) =>
    state
      .open({
        root: "userCache",
        namespace: "sources",
        key: `npm-${sha256Hex(`${registry}\0${name}@${version}`)}`,
        schema: Schema.NullOr(NpmIndexRecord),
        default: null,
        version: 1,
        onCorrupt: "discard",
        onVersionMismatch: "discard",
      })
      .pipe(
        Effect.map(regularRecord),
        mapFailures((error) => acquisitionError("cache", name, error)),
      ),
  ref: (url: string, ref: string) =>
    state
      .open({
        root: "userCache",
        namespace: "sources",
        key: `ref-${sha256Hex(`${url}#${ref}`)}`,
        schema: Schema.NullOr(RefRecord),
        default: null,
        version: 1,
        onCorrupt: "discard",
        onVersionMismatch: "discard",
      })
      .pipe(
        Effect.map(regularRecord),
        mapFailures((error) => acquisitionError("cache", "git ref", error)),
      ),
  root: (lockfile: string) =>
    state
      .open({
        root: "userCache",
        namespace: "sources",
        key: `root-${sha256Hex(lockfile)}`,
        schema: Schema.NullOr(RootRecord),
        default: null,
        version: 1,
        onCorrupt: "discard",
        onVersionMismatch: "discard",
      })
      .pipe(
        Effect.map(regularRecord),
        mapFailures((error) => acquisitionError("cache", "include root", error)),
      ),
});
