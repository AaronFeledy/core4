import { Effect, Result } from "effect";
import { ProviderInternalError } from "../errors/index.ts";
import { AbsolutePath, AppId, type AppPlan, ProviderId, type VolumeCreationFact } from "../schema/index.ts";
import type { RuntimeProviderShape } from "../services/index.ts";
import { type ContractFailure, makeTestAppPlan, mapProviderFailure, requireContract } from "./_shared.ts";

export const runProviderVolumeCreationContract = Effect.fnUntraced(function* (
  provider: RuntimeProviderShape,
  serviceStartCount: () => number,
): Effect.fn.Return<void, ContractFailure> {
  const makePlan = (): AppPlan => {
    const id = `volume-receipt-${crypto.randomUUID()}`;
    const root = AbsolutePath.make(`/tmp/${id}`);
    return {
      ...makeTestAppPlan(ProviderId.make(provider.id)),
      id: AppId.make(id),
      slug: id,
      root,
      identity: { appRoot: root, ownerKey: id },
      stores: [
        { name: `${id}-data`, scope: "app", kind: "data" },
        { name: `${id}-cache`, scope: "app", kind: "cache" },
      ],
    };
  };
  const plan = makePlan();
  const facts: VolumeCreationFact[] = [];
  const startsBefore = serviceStartCount();
  let early = true;
  const result = yield* Effect.scoped(
    provider.apply(plan, {
      reconcile: false,
      // A real async boundary: a provider that does not await the callback starts services meanwhile.
      onVolumeCreated: (fact) =>
        Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              early = early && serviceStartCount() === startsBefore;
              facts.push(fact);
            }),
          ),
        ),
    }),
  ).pipe(Effect.mapError(mapProviderFailure("apply with volume receipts succeeds")));
  yield* requireContract(
    early && serviceStartCount() > startsBefore,
    "every creation receipt precedes service startup",
  );
  yield* requireContract(
    facts.length === plan.stores.length &&
      facts.every(
        (fact, index) =>
          fact.nativeName === plan.stores[index]?.name &&
          fact.ownerRoot === plan.root &&
          fact.generation.length > 0,
      ) &&
      JSON.stringify(facts) === JSON.stringify(result.createdVolumes),
    "apply reports each verified creation exactly once through callback and result",
  );
  let adoptedCallbacks = 0;
  yield* Effect.scoped(
    provider.apply(plan, {
      reconcile: false,
      onVolumeCreated: () =>
        Effect.sync(() => {
          adoptedCallbacks += 1;
        }),
    }),
  ).pipe(Effect.mapError(mapProviderFailure("reapply with existing volumes succeeds")));
  yield* requireContract(adoptedCallbacks === 0, "existing volumes never emit creation receipts");
  yield* Effect.scoped(provider.destroy({ app: plan.id, plan }, { volumes: true })).pipe(
    Effect.mapError(mapProviderFailure("receipt contract cleanup succeeds")),
  );

  const failingPlan = makePlan();
  const failure = new ProviderInternalError({
    providerId: provider.id,
    operation: "record-volume-creation",
    message: "Receipt persistence failed.",
  });
  const startsBeforeFailure = serviceStartCount();
  let failedCallbacks = 0;
  const failed = yield* Effect.result(
    Effect.scoped(
      provider.apply(failingPlan, {
        reconcile: false,
        onVolumeCreated: () =>
          Effect.sync(() => {
            failedCallbacks += 1;
          }).pipe(Effect.andThen(Effect.fail(failure))),
      }),
    ),
  );
  yield* requireContract(
    Result.isFailure(failed) &&
      failed.failure === failure &&
      failedCallbacks === 1 &&
      serviceStartCount() === startsBeforeFailure,
    "receipt failure aborts apply before any service starts",
  );
  yield* Effect.scoped(provider.destroy({ app: failingPlan.id, plan: failingPlan }, { volumes: true })).pipe(
    Effect.mapError(mapProviderFailure("failed receipt contract cleanup succeeds")),
  );
});
