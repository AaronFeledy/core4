import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isErrnoCode } from "@lando/sdk/errors";
import { Clock, Effect } from "effect";
import { acquisitionError } from "./errors.ts";
import { cleanup } from "./gc-cleanup.ts";
import { bytesIn, detail, inspectEntry, iso, metadata, names } from "./gc-inventory.ts";
import { describeEntry, leftoverState, pruner } from "./gc-prune.ts";
import { leases, reachability } from "./gc-reachability.ts";
import type { GcEntry, GcLeftover, GcOptions, SourceGcReport } from "./gc-schema.ts";
import { io, makeStorage } from "./storage.ts";
import { containedPath } from "./tree.ts";
import type { SourceKey, SourceStoreOptions } from "./types.ts";

export type { SourceGcReport, GcOptions } from "./gc-schema.ts";
export { SourceGcReportSchema, LockKeysResult, LockKey } from "./gc-schema.ts";

export const gc = Effect.fn("SourceStore.gc")(function* (
  options: SourceStoreOptions,
  storeRoot: string,
  input: GcOptions,
) {
  if (!Number.isFinite(input.olderThanMs) || input.olderThanMs < 0)
    return yield* Effect.fail(acquisitionError("cache", "gc", "Age must be a finite non-negative duration."));
  const now = yield* Clock.currentTimeMillis;
  const cutoffMs = now - input.olderThanMs;
  const root = yield* io("source store root", async () => {
    try {
      return await realpath(storeRoot);
    } catch (cause) {
      if (isErrnoCode(cause, "ENOENT")) return resolve(storeRoot);
      throw cause;
    }
  });
  const storage = makeStorage(options, root, { token: "gc", createdAt: now });
  const records = yield* metadata(root, options.stateStore);
  const refs = yield* reachability(records, input.readLockKeys);
  const live = yield* leases(root);
  const prune = pruner(options, storage, { ...input, cutoffMs });
  const entries: GcEntry[] = [];
  const leftovers: GcLeftover[] = [];
  const failure = (id: string, reason: string): GcLeftover => ({
    kind: "inventory",
    id,
    bytes: 0,
    lastUsedAt: iso(now),
    eligible: false,
    outcome: "failed",
    reason,
  });
  for (const kind of ["git", "archive"] as const) {
    const listed = yield* Effect.result(io(kind, () => names(containedPath(root, kind))));
    if (listed._tag === "Failure") {
      leftovers.push(failure(kind, detail(listed.failure)));
      continue;
    }
    for (const id of listed.success) {
      const key: SourceKey = kind === "git" ? { kind, commit: id } : { kind, sha256: id };
      const physical = yield* Effect.result(io(id, () => inspectEntry(root, key)));
      if (physical._tag === "Failure") {
        entries.push({
          kind,
          id,
          bytes: 0,
          lastUsedAt: iso(now),
          valid: false,
          protected: false,
          leased: false,
          eligible: false,
          outcome: "failed",
          reason: detail(physical.failure),
        });
        continue;
      }
      const row = describeEntry(physical.success, { refs, live, cutoff: cutoffMs, records });
      if (!input.prune || !row.eligible) {
        entries.push(row);
        continue;
      }
      const result = yield* Effect.result(prune.entry(physical.success, row));
      entries.push(
        result._tag === "Success"
          ? result.success
          : { ...row, outcome: "failed", reason: detail(result.failure) },
      );
    }
  }
  const listedLeftovers = yield* Effect.result(io(root, () => names(root)));
  if (listedLeftovers._tag === "Failure")
    leftovers.push(failure("leftovers", detail(listedLeftovers.failure)));
  for (const id of listedLeftovers._tag === "Success" ? listedLeftovers.success : []) {
    const kind = (["staging", "replaced", "gc"] as const).find((kind) => id.startsWith(`.${kind}-`));
    if (kind === undefined) continue;
    const measured = yield* Effect.result(
      io(id, async () => {
        const path = containedPath(root, id);
        const stats = await lstat(path);
        return { mtime: stats.mtimeMs, bytes: await bytesIn(path) };
      }),
    );
    if (measured._tag === "Failure") {
      leftovers.push(failure(id, detail(measured.failure)));
      continue;
    }
    const row = leftoverState(
      {
        kind,
        id,
        bytes: measured.success.bytes,
        lastUsedAt: iso(measured.success.mtime),
        eligible: false,
        outcome: "kept",
      },
      measured.success.mtime,
      cutoffMs,
    );
    if (!input.prune || !row.eligible) {
      leftovers.push(row);
      continue;
    }
    const result = yield* Effect.result(prune.leftover(row));
    leftovers.push(
      result._tag === "Success"
        ? result.success
        : { ...row, outcome: "failed", reason: detail(result.failure) },
    );
  }
  leftovers.push(...(yield* cleanup({ options, storage, policy: input, records, live, refs })));
  const eligible = entries.filter((row) => row.eligible);
  const removed = entries.filter((row) => row.outcome === "removed");
  const observations = [refs, ...prune.observations];
  const report: SourceGcReport = {
    prune: input.prune,
    olderThanDays: input.olderThanMs / 86_400_000,
    cutoff: iso(cutoffMs),
    reachability: observations.some((row) => row.incomplete) ? "incomplete" : "complete",
    roots: observations.at(-1)?.roots ?? refs.roots,
    entries,
    leftovers,
    totals: {
      entries: entries.length,
      bytes: entries.reduce((sum, row) => sum + row.bytes, 0),
      eligible: eligible.length,
      eligibleBytes: eligible.reduce((sum, row) => sum + row.bytes, 0),
      removed: removed.length,
      removedBytes: removed.reduce((sum, row) => sum + row.bytes, 0),
      busy: entries.filter((row) => row.outcome === "busy").length,
      withheld: entries.filter((row) => row.outcome === "withheld").length,
      failed: [...entries, ...leftovers].filter((row) => row.outcome === "failed").length,
    },
  };
  return report;
});
