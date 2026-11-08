import { canonicalJson } from "@lando/sdk/digest";
import { type AppPlan, type NetworkingPlan, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { makeRouteAccumulator } from "../planner/route-identity.ts";

export interface GlobalSiblingConflict {
  readonly reason: string;
  readonly with: readonly string[];
}

const bridge = (network: NetworkingPlan | undefined) => {
  const perAppBridge = network?.perAppBridge;
  if (perAppBridge === null || perAppBridge === undefined) return perAppBridge;
  return { name: perAppBridge.name, driver: perAppBridge.driver };
};

export const globalSiblingConflicts = Effect.fn("GlobalApp.siblingConflicts")(function* (
  selected: AppPlan,
  prior: AppPlan,
  sibling: { readonly id: string; readonly routes: boolean },
) {
  const conflicts: GlobalSiblingConflict[] = [];
  const current = selected.networking;
  const previous = prior.networking;
  if (
    canonicalJson(bridge(current)) !== canonicalJson(bridge(previous)) ||
    current?.sharedNetworkMembership?.name !== previous?.sharedNetworkMembership?.name ||
    (current === undefined) !== (previous === undefined)
  ) {
    const name =
      previous?.perAppBridge?.name ??
      current?.perAppBridge?.name ??
      previous?.sharedNetworkMembership?.name ??
      current?.sharedNetworkMembership?.name ??
      "membership";
    conflicts.push({ reason: `network ${name}`, with: Object.keys(selected.services) });
  }
  for (const network of previous?.authoredNetworks ?? []) {
    if (!Object.hasOwn(network.members, sibling.id)) continue;
    const next = current?.authoredNetworks?.find((entry) => entry.name === network.name);
    if (
      next !== undefined &&
      canonicalJson({ ...next, members: undefined }) !== canonicalJson({ ...network, members: undefined })
    ) {
      conflicts.push({ reason: `network ${network.name}`, with: Object.keys(next.members) });
    }
  }
  const mounted = new Set(
    prior.services[ServiceName.make(sibling.id)]?.mounts.flatMap((mount) =>
      mount.type === "volume" ? [mount.store] : [],
    ) ?? [],
  );
  for (const store of prior.stores) {
    if (!mounted.has(store.name)) continue;
    const next = selected.stores.find((entry) => entry.name === store.name);
    if (next === undefined || canonicalJson(next) === canonicalJson(store)) continue;
    const users = Object.entries(selected.services).filter(([, service]) =>
      service.mounts.some((mount) => mount.type === "volume" && mount.store === store.name),
    );
    conflicts.push({ reason: `data store ${store.name}`, with: users.map(([id]) => id) });
  }
  if (sibling.routes) {
    const selectedRoutes = selected.routes.filter((route) => Object.hasOwn(selected.services, route.service));
    for (const old of prior.routes.filter((route) => route.service === sibling.id)) {
      for (const route of selectedRoutes) {
        const accumulator = makeRouteAccumulator();
        yield* accumulator.add(route, { key: String(route.service) });
        const result = yield* Effect.result(accumulator.add(old, { key: sibling.id }));
        if (result._tag === "Failure") {
          conflicts.push({ reason: `route host ${old.hostname}`, with: [String(route.service)] });
        }
      }
    }
  }
  return conflicts.filter((conflict) => conflict.with.length > 0);
});
