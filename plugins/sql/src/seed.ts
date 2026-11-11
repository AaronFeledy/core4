import { randomUUID } from "node:crypto";
import type { SqlSeedStateError } from "@lando/sdk/errors";
import {
  AppId,
  type DataTransferSpec,
  type Environment,
  type EnvironmentValue,
  ServiceName,
  type SnapshotInfo,
  type VolumeRef,
  snapshotHandle,
} from "@lando/sdk/schema";
import { Effect, Exit } from "effect";

import { type SqlExec, runImport } from "./actions.ts";
import { checkedSqlExecution } from "./checked-execution.ts";
import { parseCount } from "./command-input.ts";
import { registerSqlCredentials, resolveSqlEnvironment } from "./environment.ts";
import { countCommand, loadCommand } from "./families.ts";
import type { SqlRecoveryContext, SqlRecoveryDeps } from "./recovery.ts";
import { seedStateError } from "./seed-state.ts";
import { requireSeedCompatibleSnapshot } from "./snapshot-compatibility.ts";
import type { SqlPlan } from "./views.ts";

export const executeSeed = Effect.fn("Sql.seed")(function* (
  deps: SqlRecoveryDeps & { readonly exec: SqlExec },
  context: SqlRecoveryContext,
  input: Parameters<typeof runImport>[2] & {
    readonly snapshot?: SnapshotInfo;
    readonly source?: {
      readonly plan: SqlPlan;
      readonly endpoint: Omit<
        Extract<DataTransferSpec["from"], { readonly _tag: "serviceCmd" }>,
        "env" | "secrets"
      > & {
        readonly env: Environment;
      };
      readonly database: string;
      readonly credentials: ReadonlyArray<EnvironmentValue>;
      readonly redactionTokens: string[];
    };
    readonly store: VolumeRef;
  },
) {
  const reject = (status: SqlSeedStateError["status"]) => seedStateError(input.service, status);
  const identity = context.volumeIdentity;
  if (identity.origin !== "created" || identity.ownerRoot !== context.owner.appRoot)
    return yield* Effect.fail(reject("unknown"));
  const state = yield* deps.initialization(identity);
  const status = (yield* state.read)?.state._tag ?? "unknown";
  if (status !== "fresh") return yield* Effect.fail(reject(status));
  const command = countCommand(input.family, input.creds);
  const counted = yield* checkedSqlExecution(deps.exec(input.service, command, input.env), {
    service: input.service,
    command,
    env: input.env,
    secrets: input.secrets,
  });
  const count = parseCount(counted.stdout);
  if (count !== 0) {
    return yield* Effect.fail(reject(status));
  }
  const seedHandle = input.snapshot === undefined ? undefined : snapshotHandle(input.snapshot);
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
          const registered = yield* registerSqlCredentials(input.source.plan, input.source.credentials);
          input.source.redactionTokens.push(...registered.substringTokens);
          const sourceEnv = yield* resolveSqlEnvironment(input.source.endpoint.env);
          const targetEnv = yield* resolveSqlEnvironment(input.env);
          const targetSecrets = input.secrets();
          return yield* deps.transfer({
            from: {
              ...input.source.endpoint,
              env: sourceEnv,
              secrets: registered.secrets,
            },
            to: {
              _tag: "serviceCmd",
              app: AppId.make(input.plan.id),
              service: ServiceName.make(input.service),
              command: loadCommand(input.family, input.creds, input.source.database),
              env: targetEnv,
              secrets: targetSecrets,
            },
            overwrite: true,
          });
        }
        return yield* seedHandle === undefined
          ? runImport(deps, deps.exec, input)
          : Effect.gen(function* () {
              if (context.running) yield* context.suspend;
              yield* context.verifyVolume;
              yield* deps.restore(
                seedHandle,
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
