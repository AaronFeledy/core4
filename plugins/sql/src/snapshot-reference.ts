import { DateTime, Effect } from "effect";

import { SnapshotAmbiguousError, SnapshotNotFoundError } from "@lando/sdk/errors";
import type { SqlCommandDeps } from "./command-types.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";

export const resolveSnapshotReference = Effect.fn("Sql.resolveSnapshotReference")(function* (
  deps: Pick<SqlCommandDeps, "listSnapshots">,
  reference: string,
  source: Parameters<typeof resolveSnapshotSource>[0],
) {
  const exact = (yield* deps.listSnapshots({ id: reference })).find((entry) => entry.id === reference);
  if (exact !== undefined) return exact;
  const scope = yield* resolveSnapshotSource(source);
  const matches = (yield* deps.listSnapshots({ ...scope, label: reference }))
    .filter((entry) => entry.label === reference)
    .toSorted(
      (left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    );
  if (matches.length > 1) {
    return yield* Effect.fail(
      new SnapshotAmbiguousError({
        message: `Snapshot label ${reference} matches ${matches.length} snapshots.`,
        snapshotId: reference,
        matchCount: matches.length,
        candidateIds: matches.map((entry) => entry.id),
        remediation: "Run `lando db:snapshots` and retry with one of the matching snapshot ids.",
      }),
    );
  }
  const match = matches[0];
  if (match !== undefined) return match;
  return yield* Effect.fail(
    new SnapshotNotFoundError({
      message: `Snapshot ${reference} was not found.`,
      snapshotId: reference,
      remediation: `Run \`lando db:snapshots\` to list snapshot ids and labels for ${source.service}, then retry with one of them.`,
    }),
  );
});
