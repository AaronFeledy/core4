import { lstat, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import type { SourceAcquisitionError } from "./errors.ts";
import {
  type PhysicalEntry,
  type StoredRecord,
  detail,
  inspectEntry,
  iso,
  metadata,
} from "./gc-inventory.ts";
import { type LeaseFile, type Reachability, leasedKeys, leases, reachability } from "./gc-reachability.ts";
import type { GcEntry, GcLeftover, GcOptions } from "./gc-schema.ts";
import { type Storage, io, keyId, processIsAlive } from "./storage.ts";
import { containedPath, realContainedPath } from "./tree.ts";
import type { SourceStoreOptions } from "./types.ts";

interface GcView {
  readonly refs: Reachability;
  readonly live: readonly LeaseFile[];
  readonly cutoff: number;
  readonly records: readonly StoredRecord[];
}
export const describeEntry = (physical: PhysicalEntry, view: GcView): GcEntry => {
  const { refs, live, cutoff, records } = view;
  const id = keyId(physical.key);
  const protectedEntry = physical.key.kind === "git" ? refs.git.has(id) : refs.archives.has(id);
  const leased = leasedKeys(live).has(`${physical.key.kind}/${id}`);
  const uncertain =
    live.some((lease) => lease.error !== undefined) ||
    (refs.incomplete && (physical.key.kind === "git" || refs.indexed.has(id) || refs.unknownArchives));
  const eligible = !protectedEntry && !leased && !uncertain && (!physical.valid || physical.mtime < cutoff);
  const npm = records.flatMap((row) =>
    row.kind === "npm-index" && row.value.sha256 === id
      ? [{ name: row.value.name, version: row.value.version, registry: row.value.registry }]
      : [],
  );
  const row: GcEntry = {
    kind: physical.key.kind,
    id,
    bytes: physical.bytes,
    lastUsedAt: iso(physical.mtime),
    valid: physical.valid,
    protected: protectedEntry,
    leased,
    eligible,
    outcome: "kept",
    ...(npm.length === 0 ? {} : { npm }),
  };
  if (leased) return { ...row, outcome: "busy", reason: "leased" };
  if (uncertain) return { ...row, outcome: "withheld", reason: "incomplete-reachability" };
  if (protectedEntry) return { ...row, reason: "referenced" };
  return { ...row, reason: eligible ? "eligible" : "recent" };
};
export const retire = <A extends GcEntry | GcLeftover>(
  storage: Storage,
  path: string,
  decide: Effect.Effect<A, SourceAcquisitionError>,
): Effect.Effect<A, SourceAcquisitionError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const plan = yield* storage.locked(
        Effect.gen(function* () {
          const report = yield* decide;
          if (!report.eligible || report.outcome === "failed") return { report, aside: undefined };
          // decide re-observes PID liveness, references and namespace membership
          // under this lock; the inventory is never authority to remove a path.
          const aside = containedPath(storage.root, `.gc-${process.pid}-${crypto.randomUUID()}`);
          yield* io(report.id, async () => {
            await realContainedPath(storage.root, dirname(path));
            await rename(path, aside);
          });
          return { report, aside };
        }),
      );
      const aside = plan.aside;
      if (aside === undefined) return plan.report;
      const erased = yield* Effect.result(
        io(plan.report.id, () => rm(aside, { recursive: true, force: true })),
      );
      switch (erased._tag) {
        case "Success":
          return { ...plan.report, outcome: "removed" };
        case "Failure":
          return { ...plan.report, outcome: "failed", reason: detail(erased.failure) };
        default: {
          const exhaustive: never = erased;
          return exhaustive;
        }
      }
    }),
  );
const leftoverOwner = (id: string): number | undefined => {
  const match = /^\.(?:staging|replaced|gc)-(\d+)-/u.exec(id);
  const pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : undefined;
};
export const leftoverState = (row: GcLeftover, mtime: number, cutoff: number): GcLeftover => {
  const pid = leftoverOwner(row.id);
  const live = pid !== undefined && processIsAlive(pid);
  return {
    ...row,
    eligible: !live && (pid !== undefined || mtime < cutoff),
    outcome: live ? "busy" : "kept",
    reason: live ? "live-owner" : "dead-owner",
    ...(pid === undefined ? {} : { pid }),
  };
};
export const pruner = (
  options: SourceStoreOptions,
  storage: Storage,
  policy: GcOptions & { readonly cutoffMs: number },
) => {
  const observations: Reachability[] = [];
  return {
    observations,
    entry: (physical: PhysicalEntry, initial: GcEntry) =>
      retire(
        storage,
        physical.path,
        Effect.gen(function* () {
          const records = yield* metadata(storage.root, options.stateStore);
          const refs = yield* reachability(records, policy.readLockKeys);
          observations.push(refs);
          const live = yield* leases(storage.root);
          const checked = yield* Effect.result(
            io(initial.id, () => inspectEntry(storage.root, physical.key)),
          );
          if (checked._tag === "Failure") {
            return {
              ...initial,
              eligible: false,
              outcome: "failed" as const,
              reason: detail(checked.failure),
            };
          }
          const current = describeEntry(checked.success, { refs, live, cutoff: policy.cutoffMs, records });
          return !current.eligible && !current.protected && current.outcome === "kept"
            ? { ...current, outcome: "busy" as const, reason: "touched-after-cutoff" }
            : current;
        }),
      ),
    leftover: (row: GcLeftover) =>
      retire(
        storage,
        containedPath(storage.root, row.id),
        Effect.gen(function* () {
          const stats = yield* io(row.id, () => lstat(containedPath(storage.root, row.id)));
          return leftoverState({ ...row, lastUsedAt: iso(stats.mtimeMs) }, stats.mtimeMs, policy.cutoffMs);
        }),
      ),
  };
};
