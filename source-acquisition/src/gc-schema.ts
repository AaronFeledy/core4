import { type Effect, Schema } from "effect";

export const LockKey = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    commit: Schema.String.check(Schema.isPattern(/^[a-f\d]{40}$/u)),
  }),
  Schema.Struct({
    kind: Schema.Literal("npm"),
    name: Schema.NonEmptyString,
    version: Schema.String.check(
      Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
    ),
  }),
]);
export const LockKeysResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), keys: Schema.Array(LockKey) }),
  Schema.Struct({ status: Schema.Literal("missing") }),
  Schema.Struct({ status: Schema.Literals(["unreadable", "corrupt"]), detail: Schema.String }),
]);
export type LockKeysResult = typeof LockKeysResult.Type;
export type LockKey = typeof LockKey.Type;
export const GcOutcome = Schema.Literals(["kept", "removed", "busy", "withheld", "failed"]);
// GC rows are observations, never persisted lifecycle states. Eligibility
// cannot authorize removal of an entry whose same observation protects it.
export const GcEntry = Schema.Struct({
  kind: Schema.Literals(["git", "archive"]),
  id: Schema.String,
  bytes: Schema.Number,
  lastUsedAt: Schema.String,
  valid: Schema.Boolean,
  protected: Schema.Boolean,
  leased: Schema.Boolean,
  eligible: Schema.Boolean,
  outcome: GcOutcome,
  reason: Schema.optionalKey(Schema.String),
  npm: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String, registry: Schema.String })),
  ),
}).check(
  Schema.makeFilter(
    (row) =>
      !row.eligible ||
      (!row.protected && !row.leased && row.outcome !== "busy" && row.outcome !== "withheld"),
    { expected: "only unprotected, unleased entries may be eligible" },
  ),
);
export const GcLeftover = Schema.Struct({
  kind: Schema.Literals(["staging", "replaced", "gc", "lease", "npm-index", "ref", "root", "inventory"]),
  id: Schema.String,
  bytes: Schema.Number,
  lastUsedAt: Schema.String,
  eligible: Schema.Boolean,
  outcome: GcOutcome,
  reason: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Number),
}).check(
  Schema.makeFilter((row) => !row.eligible || (row.outcome !== "busy" && row.outcome !== "withheld"), {
    expected: "busy or withheld leftovers cannot be eligible",
  }),
);
export const SourceGcReportSchema = Schema.Struct({
  prune: Schema.Boolean,
  olderThanDays: Schema.Number,
  cutoff: Schema.String,
  reachability: Schema.Literals(["complete", "incomplete"]),
  roots: Schema.Array(
    Schema.Struct({
      lockfile: Schema.String,
      status: Schema.Literals(["ok", "missing", "unreadable", "corrupt"]),
      detail: Schema.optionalKey(Schema.String),
    }),
  ),
  entries: Schema.Array(GcEntry),
  leftovers: Schema.Array(GcLeftover),
  totals: Schema.Struct({
    entries: Schema.Number,
    bytes: Schema.Number,
    eligible: Schema.Number,
    eligibleBytes: Schema.Number,
    removed: Schema.Number,
    removedBytes: Schema.Number,
    busy: Schema.Number,
    withheld: Schema.Number,
    failed: Schema.Number,
  }),
});
export type SourceGcReport = typeof SourceGcReportSchema.Type;
export type GcEntry = typeof GcEntry.Type;
export type GcLeftover = typeof GcLeftover.Type;
export type GcRoot = SourceGcReport["roots"][number];

export interface GcOptions {
  readonly prune: boolean;
  readonly olderThanMs: number;
  readonly readLockKeys: (lockfile: string) => Effect.Effect<LockKeysResult>;
}
