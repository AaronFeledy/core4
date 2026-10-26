import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, landoNetworkNames } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Effect } from "effect";
import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { inspectOwnedNativeId, isSharedNetwork, networkOwnershipLabels } from "./native-ownership.ts";
import { type makeResourceOwnershipStore, ownershipFailure } from "./resource-ownership.ts";

/** Run only after bring-up has detached replaced containers from their old networks. */
export const removeOrphanedNetworks = Effect.fn("RuntimeProvider.removeOrphanedNetworks")(function* (
  plan: AppPlan,
  previous: AppPlan | undefined,
  options: {
    readonly api?: {
      readonly request?: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>;
    };
    readonly ctx: ProviderErrorContext;
    readonly store: ReturnType<typeof makeResourceOwnershipStore>;
  },
) {
  if (previous === undefined) return;
  const current = new Set(landoNetworkNames(plan));
  const orphaned = (previous.networking?.authoredNetworks ?? []).filter(
    (network) =>
      !network.external &&
      !current.has(network.name) &&
      network.name !== previous.networking?.perAppBridge?.name &&
      !isSharedNetwork(previous, network.name) &&
      !isSharedNetwork(plan, network.name),
  );
  if (orphaned.length === 0) return;
  const api = options.api;
  if (api?.request === undefined) return yield* Effect.fail(ownershipFailure(options.ctx.providerId));
  const inventory = yield* options.store.load(previous.root);
  for (const network of orphaned) {
    const id = yield* inspectOwnedNativeId(
      api,
      {
        kind: "network",
        name: network.name,
        labels: networkOwnershipLabels(previous),
        legacy: "reject",
        exactName: true,
      },
      options.ctx,
    );
    if (id !== undefined) {
      const response = yield* api.request({ method: "DELETE", path: `/networks/${encodeURIComponent(id)}` });
      if (
        ((response.status === 403 || response.status === 409) &&
          /active endpoints|in use/iu.test(response.body)) ||
        (response.status === 500 && /network is being used/iu.test(response.body))
      )
        continue;
      if (![200, 204, 404].includes(response.status))
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: options.ctx.providerId,
            operation: "cleanupOwnedResources",
            message: "Verified resource removal failed.",
            remediation: options.ctx.remediation,
          }),
        );
    }
    for (const resource of inventory?.resources ?? []) {
      if (
        resource.kind === "network" &&
        resource.nativeName === network.name &&
        resource.appId === previous.id
      )
        yield* options.store.retire(previous.root, resource);
    }
  }
});
