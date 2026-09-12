import { Effect } from "effect";

import { SqlSeedStateError } from "@lando/sdk/errors";
import type { VolumeRef } from "@lando/sdk/schema";

import { type SqlExec, runImport } from "./actions.ts";
import { parseCount } from "./command-input.ts";
import { countCommand } from "./families.ts";
import type { SqlRecoveryContext, SqlRecoveryDeps } from "./recovery.ts";
import { requireCompatibleSnapshot } from "./snapshot-compatibility.ts";

export const executeSeed = (
  deps: SqlRecoveryDeps & { readonly exec: SqlExec },
  context: SqlRecoveryContext,
  input: Parameters<typeof runImport>[2] & { readonly snapshotId?: string; readonly store: VolumeRef },
) =>
  Effect.gen(function* () {
    const status = yield* deps.getSeedStatus(context.metadata.volumeInstanceId);
    const counted = yield* deps.exec(input.service, countCommand(input.family, input.creds), input.env);
    const count = counted.ok ? parseCount(counted.stdout) : undefined;
    if (status !== "fresh" || count !== 0) {
      return yield* Effect.fail(
        new SqlSeedStateError({
          message: `Cannot seed ${input.service} from state ${status}.`,
          service: input.service,
          status,
          remediation: "Create a fresh database volume or explicitly import into the existing database.",
        }),
      );
    }
    const seedSnapshotId = input.snapshotId;
    if (seedSnapshotId !== undefined) {
      const source = (yield* deps.listSnapshots({ id: seedSnapshotId })).find(
        (candidate) => candidate.id === seedSnapshotId,
      );
      yield* requireCompatibleSnapshot(source, context);
    }
    yield* deps.setSeedStatus(context.metadata.volumeInstanceId, "in-progress");
    const seeded = (
      seedSnapshotId === undefined
        ? runImport(deps, deps.exec, input)
        : Effect.gen(function* () {
            if (context.running) yield* deps.stop(input.service);
            yield* deps.restore(seedSnapshotId, input.store);
            if (context.running) yield* deps.start(input.service);
            return undefined;
          })
    ).pipe(Effect.tapError(() => deps.setSeedStatus(context.metadata.volumeInstanceId, "failed")));
    const result = yield* seeded;
    yield* deps.setSeedStatus(context.metadata.volumeInstanceId, "seeded");
    return result;
  });
