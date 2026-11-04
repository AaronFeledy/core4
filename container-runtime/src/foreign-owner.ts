import { type AppPlan, landoOwnedNetworkNames } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Effect } from "effect";
import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import {
  containerOwnershipLabels,
  inspectOwnedNativeId,
  isSharedNetwork,
  networkOwnershipLabels,
} from "./native-ownership.ts";
import { serviceContainerName } from "./plan.ts";

/**
 * Applied plans are keyed by app id, so a second directory with the same `name:` resolves the
 * other app's plan as `previous`. Inspect this plan's names first: a resource whose labels prove
 * another app's ownership fails with the refusal naming that app's root, before any mutation.
 */
export const refuseOtherAppsResources = Effect.fn("RuntimeProvider.refuseOtherAppsResources")(function* (
  plan: AppPlan,
  previous: AppPlan | undefined,
  options: {
    readonly api?: {
      readonly request?: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>;
    };
    readonly ctx: ProviderErrorContext;
  },
) {
  const api = options.api;
  if (previous === undefined || previous.root === plan.root || api?.request === undefined) return;
  for (const service of Object.values(plan.services))
    yield* inspectOwnedNativeId(
      api,
      {
        kind: "container",
        name: serviceContainerName(plan, service.name),
        labels: containerOwnershipLabels(plan, service.name),
      },
      options.ctx,
    );
  const labels = networkOwnershipLabels(plan);
  for (const name of landoOwnedNetworkNames(plan))
    if (!isSharedNetwork(plan, name))
      yield* inspectOwnedNativeId(
        api,
        { kind: "network", name, labels, legacy: "reject", exactName: true },
        options.ctx,
      );
});
