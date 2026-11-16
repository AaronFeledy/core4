import { RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import { executeLockedTeardown } from "./destroy-execute-locked.ts";
import type { TeardownPlan } from "./destroy-plan.ts";

export const executeTeardown = Effect.fn("AppOperation.executeTeardown")(function* (plan: TeardownPlan) {
  const target = plan.target;
  const work = Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    if (target === undefined) return yield* executeLockedTeardown(plan);
    const provider = yield* registry.select(target.plan);
    const stateStore = yield* StateStore;
    return yield* withPlanVolumeCoordination({
      plan: target.plan,
      provider,
      stateStore,
      body: () => executeLockedTeardown(plan),
    });
  });
  const refs =
    plan.refs.length === 0 ? [{ kind: "user" as const, id: plan.name, root: plan.root }] : plan.refs;
  return yield* [...refs]
    .sort((a, b) => `${a.root}\0${a.id}`.localeCompare(`${b.root}\0${b.id}`))
    .reduceRight((body, ref) => withAppMutationLock(ref, body), work);
});
