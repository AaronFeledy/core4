import { randomUUID } from "node:crypto";
import { Effect, Exit } from "effect";

import { SqlSeedStateError } from "@lando/sdk/errors";
import {
  AppId,
  type DataTransferSpec,
  ServiceName,
  type SnapshotInfo,
  type VolumeRef,
} from "@lando/sdk/schema";

import { type SqlExec, runImport } from "./actions.ts";
import { parseCount } from "./command-input.ts";
import { countCommand, loadCommand } from "./families.ts";
import type { SqlRecoveryContext, SqlRecoveryDeps } from "./recovery.ts";
import { requireSeedCompatibleSnapshot } from "./snapshot-compatibility.ts";

export const executeSeed = Effect.fn("Sql.seed")(function* (
  deps: SqlRecoveryDeps & { readonly exec: SqlExec },
  context: SqlRecoveryContext,
  input: Parameters<typeof runImport>[2] & {
    readonly snapshot?: SnapshotInfo;
    readonly source?: {
      readonly endpoint: Extract<DataTransferSpec["from"], { readonly _tag: "serviceCmd" }>;
      readonly database: string;
    };
    readonly store: VolumeRef;
  },
) {
  const reject = (status: SqlSeedStateError["status"]) =>
    new SqlSeedStateError({
      message: `Cannot seed ${input.service} from state ${status}.`,
      service: input.service,
      status,
      remediation: "Create a fresh database volume or explicitly import into the existing database.",
    });
  const identity = context.volumeIdentity;
  if (!identity || identity.origin !== "created" || identity.ownerRoot !== context.metadata.sourceRoot)
    return yield* Effect.fail(reject("unknown"));
  const state = yield* deps.initialization(identity);
  const status = (yield* state.read)?.state._tag ?? "unknown";
  if (status !== "fresh") return yield* Effect.fail(reject(status));
  const counted = yield* deps.exec(input.service, countCommand(input.family, input.creds), input.env);
  const count = counted.ok ? parseCount(counted.stdout) : undefined;
  if (count !== 0) {
    return yield* Effect.fail(
      new SqlSeedStateError({
        message: `Cannot seed ${input.service} from state ${status}.`,
        service: input.service,
        status,
        remediation: "Create a fresh database volume or explicitly import into the existing database.",
      }),
    );
  }
  const seedSnapshotId = input.snapshot?.id;
  if (input.snapshot !== undefined) {
    yield* requireSeedCompatibleSnapshot(input.snapshot, context);
  }
  const operationId = randomUUID();
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (!(yield* state.begin(operationId))) return yield* Effect.fail(reject("in-progress"));
      const seeded = Effect.gen(function* () {
        yield* context.verifyVolume;
        if (input.source !== undefined) {
          return yield* deps.transfer({
            from: input.source.endpoint,
            to: {
              _tag: "serviceCmd",
              app: AppId.make(input.plan.id),
              service: ServiceName.make(input.service),
              command: loadCommand(input.family, input.creds, input.source.database),
              env: input.env,
            },
            overwrite: true,
          });
        }
        return yield* seedSnapshotId === undefined
          ? runImport(deps, deps.exec, input)
          : Effect.gen(function* () {
              if (context.running) yield* context.suspend;
              yield* context.verifyVolume;
              yield* deps.restore(
                seedSnapshotId,
                { ...input.store, store: identity.nativeName },
                { mode: "seed" },
              );
              if (context.running) yield* context.resume;
              return undefined;
            });
      });
      const result = yield* restore(seeded).pipe(Effect.exit);
      const finished = yield* state.finish({
        operationId,
        outcome: Exit.isSuccess(result) ? "seeded" : "failed",
      });
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      if (!finished) return yield* Effect.fail(reject("unknown"));
      return result.value;
    }),
  );
});
