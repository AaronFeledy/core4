import type { AppPlan } from "@lando/sdk/schema";
import { type ProviderError, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

declare const prepared: unique symbol;

export type PreparedRuntimeProvider = RuntimeProviderShape & { readonly [prepared]: true };

export const prepareProvider = Effect.fn("RuntimeProvider.prepare")(function* (
  provider: RuntimeProviderShape,
): Effect.fn.Return<PreparedRuntimeProvider, ProviderError> {
  yield* provider.ensureReady ?? Effect.void;
  return provider as PreparedRuntimeProvider;
});

export const selectPreparedProvider = Effect.fn("RuntimeProvider.selectPrepared")(function* (plan: AppPlan) {
  const registry = yield* RuntimeProviderRegistry;
  return yield* prepareProvider(yield* registry.select(plan));
});
