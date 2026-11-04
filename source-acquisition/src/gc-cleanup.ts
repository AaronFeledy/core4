import { lstat } from "node:fs/promises";
import { isErrnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";
import { type StoredRecord, detail, iso, metadata } from "./gc-inventory.ts";
import { retire } from "./gc-prune.ts";
import { type LeaseFile, type Reachability, leases, reachability } from "./gc-reachability.ts";
import type { GcLeftover, GcOptions } from "./gc-schema.ts";
import { type Storage, io } from "./storage.ts";
import { containedPath } from "./tree.ts";
import type { SourceStoreOptions } from "./types.ts";

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return false;
    throw cause;
  }
};
const describeRecord = Effect.fn("SourceGc.describeRecord")(function* (
  row: StoredRecord,
  root: string,
  refs: Reachability,
) {
  const base: GcLeftover = {
    kind: row.kind === "failed" ? row.keyKind : row.kind,
    id: row.name,
    bytes: row.bytes,
    lastUsedAt: iso(row.mtime),
    eligible: false,
    outcome: "kept",
  };
  switch (row.kind) {
    case "failed":
      return { ...base, outcome: "failed" as const, reason: row.reason };
    case "root": {
      const missing = refs.roots.some(
        (item) => item.lockfile === row.value.lockfile && item.status === "missing",
      );
      return { ...base, eligible: missing, reason: missing ? "missing-lockfile" : "lockfile-present" };
    }
    case "ref": {
      const dangling = !(yield* io(row.name, () => exists(containedPath(root, "git", row.value.commit))));
      return { ...base, eligible: dangling, reason: dangling ? "missing-entry" : "entry-present" };
    }
    case "npm-index": {
      if (refs.archives.has(row.value.sha256)) return { ...base, reason: "referenced" };
      if (refs.incomplete)
        return { ...base, outcome: "withheld" as const, reason: "incomplete-reachability" };
      const dangling = !(yield* io(row.name, () => exists(containedPath(root, "archive", row.value.sha256))));
      return { ...base, eligible: dangling, reason: dangling ? "missing-entry" : "entry-present" };
    }
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
});
const describeLease = (row: LeaseFile): GcLeftover => ({
  kind: "lease",
  id: row.name,
  bytes: row.bytes,
  lastUsedAt: iso(row.mtime),
  eligible: !row.live,
  outcome: row.error !== undefined ? "failed" : row.live ? "busy" : "kept",
  reason: row.error ?? (row.live ? "live-lease" : "dead-lease"),
  ...(row.pid === undefined ? {} : { pid: row.pid }),
});
export const cleanup = Effect.fn("SourceGc.cleanup")(function* (context: {
  readonly options: SourceStoreOptions;
  readonly storage: Storage;
  readonly policy: GcOptions;
  readonly records: readonly StoredRecord[];
  readonly live: readonly LeaseFile[];
  readonly refs: Reachability;
}) {
  const { options, storage, policy } = context;
  const rows: GcLeftover[] = [];
  for (const record of context.records) {
    const inspected = yield* Effect.result(describeRecord(record, storage.root, context.refs));
    if (inspected._tag === "Failure") {
      rows.push({
        kind: record.kind === "failed" ? record.keyKind : record.kind,
        id: record.name,
        bytes: record.bytes,
        lastUsedAt: iso(record.mtime),
        eligible: false,
        outcome: "failed",
        reason: detail(inspected.failure),
      });
      continue;
    }
    const initial = inspected.success;
    if (!policy.prune || initial.outcome === "failed") {
      rows.push(initial);
      continue;
    }
    const result = yield* Effect.result(
      retire(
        storage,
        record.path,
        Effect.gen(function* () {
          const records = yield* metadata(storage.root, options.stateStore);
          const current = records.find((row) => row.name === record.name);
          if (current === undefined) return { ...initial, eligible: false, reason: "no-longer-present" };
          if (current.kind === "root" && (yield* leases(storage.root)).some((row) => row.live)) {
            return { ...initial, eligible: false, outcome: "busy" as const, reason: "live-lease" };
          }
          const refs = yield* reachability(records, policy.readLockKeys);
          return yield* describeRecord(current, storage.root, refs);
        }),
      ),
    );
    rows.push(
      result._tag === "Success"
        ? result.success
        : { ...initial, outcome: "failed", reason: detail(result.failure) },
    );
  }
  for (const lease of context.live) {
    const initial = describeLease(lease);
    if (!policy.prune || !initial.eligible) {
      rows.push(initial);
      continue;
    }
    const result = yield* Effect.result(
      retire(
        storage,
        lease.path,
        Effect.gen(function* () {
          const current = (yield* leases(storage.root)).find((row) => row.name === lease.name);
          return current === undefined
            ? { ...initial, eligible: false, reason: "no-longer-present" }
            : describeLease(current);
        }),
      ),
    );
    rows.push(
      result._tag === "Success"
        ? result.success
        : { ...initial, outcome: "failed", reason: detail(result.failure) },
    );
  }
  return rows;
});
