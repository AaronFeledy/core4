import { type Context, Effect } from "effect";
import { RuntimeProviderRegistry } from "../services/provider.ts";
import { TestRuntimeProvider } from "./provider-data-plane.ts";

type Registry = Context.Service.Shape<typeof RuntimeProviderRegistry>;

/** Models an empty host. Override the registry members your test exercises. */
export const makeTestRuntimeProviderRegistry = (overrides: Partial<Registry> = {}): Registry =>
  RuntimeProviderRegistry.of({
    list: Effect.succeed([]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
    appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
    readAppliedPlanStrict: () => Effect.succeed(undefined),
    ...overrides,
  });
