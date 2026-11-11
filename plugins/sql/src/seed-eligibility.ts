import { Effect } from "effect";
import type { SqlRecoveryDeps } from "./recovery.ts";
import { seedStateError } from "./seed-state.ts";
import { type SqlPlan, type SqlPlanService, sqlPlanIdentity } from "./views.ts";
import { requireDatabaseMount } from "./volume-target.ts";

/**
 * Advisory checks before a seed reads its dump, so a refused seed of a large dump returns at once.
 * Reads state and counts tables only; any failed lookup defers to the authoritative check under
 * the volume lock, which repeats every check before it claims the volume.
 */
export const precheckSeedEligibility = Effect.fn("Sql.precheckSeedEligibility")(function* <R>(
  deps: Pick<SqlRecoveryDeps, "inspectVolume" | "initialization">,
  input: {
    readonly plan: SqlPlan;
    readonly service: SqlPlanService;
    readonly serviceName: string;
    /** Table or collection count; fails when the database can't answer, as when it's stopped. */
    readonly count: Effect.Effect<number | undefined, unknown, R>;
  },
) {
  const refusal = yield* Effect.gen(function* () {
    const mount = yield* requireDatabaseMount(input.service, input.plan.id);
    const volume = yield* deps.inspectVolume(input.serviceName, mount.store, mount.target);
    const identity = volume?.identity;
    if (identity === undefined) return undefined;
    if (identity.origin !== "created" || identity.ownerRoot !== sqlPlanIdentity(input.plan).appRoot)
      return seedStateError(input.serviceName, "unknown");
    const state = yield* deps.initialization(identity);
    const record = yield* state.read;
    if (record === null) return undefined;
    if (record.state._tag !== "fresh") return seedStateError(input.serviceName, record.state._tag);
    const count = yield* input.count;
    return count !== undefined && count > 0 ? seedStateError(input.serviceName, "fresh") : undefined;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (refusal !== undefined) return yield* Effect.fail(refusal);
});
