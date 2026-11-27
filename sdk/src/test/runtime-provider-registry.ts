import { type Context, Effect } from "effect";
import { RuntimeProviderRegistry } from "../services/provider.ts";
import { TestRuntimeProvider } from "./provider-data-plane.ts";

type Registry = Context.Service.Shape<typeof RuntimeProviderRegistry>;

/**
 * Models an empty host. Override the registry members your test exercises. When a test supplies
 * only `appliedStateInventory`, the targeted strict read answers from that inventory so the two
 * views of applied state cannot disagree.
 */
export const makeTestRuntimeProviderRegistry = (overrides: Partial<Registry> = {}): Registry => {
  const inventory = overrides.appliedStateInventory;
  return RuntimeProviderRegistry.of({
    list: Effect.succeed([]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
    appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
    readAppliedPlanStrict:
      inventory === undefined
        ? () => Effect.succeed(undefined)
        : ({ id, provider }) =>
            inventory(provider).pipe(
              Effect.map(({ plans }) => plans.find((plan) => plan.id === id && plan.provider === provider)),
            ),
    ...overrides,
  });
};
