import { mapFailures } from "@lando/sdk/command-result";
import { canonicalJson } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import type { AppPlan, NetworkingPlan, ServicePlan } from "@lando/sdk/schema";
import { Effect } from "effect";

import { makeRouteAccumulator } from "../planner/route-identity.ts";
import { selectGlobalPlan } from "./global-selected-plan.ts";

const conflict = (message: string) =>
  new GlobalAppError({
    operation: "start",
    message,
    remediation: "Run `lando global:restart` to recreate every global service from its current definition.",
  });

const retainedNetworking = Effect.fn("GlobalApp.retainNetworking")(function* (
  desired: NetworkingPlan | undefined,
  prior: NetworkingPlan | undefined,
  retained: ReadonlySet<string>,
) {
  if (retained.size === 0) return desired;
  if (desired === undefined && prior === undefined) return undefined;
  if (desired === undefined || prior === undefined)
    return yield* Effect.fail(
      conflict(
        `Global services ${[...retained].join(", ")} have conflicting network metadata (${prior?.perAppBridge?.name ?? desired?.perAppBridge?.name ?? prior?.sharedNetworkMembership?.name ?? desired?.sharedNetworkMembership?.name ?? "unknown network"}).`,
      ),
    );
  const bridge = (network: NetworkingPlan) =>
    network.perAppBridge === null
      ? null
      : { name: network.perAppBridge.name, driver: network.perAppBridge.driver };
  if (
    canonicalJson(bridge(desired)) !== canonicalJson(bridge(prior)) ||
    desired.sharedNetworkMembership?.name !== prior.sharedNetworkMembership?.name
  )
    return yield* Effect.fail(
      conflict(
        `Global services ${[...retained].join(", ")} still use conflicting network ${prior.perAppBridge?.name ?? desired.perAppBridge?.name ?? prior.sharedNetworkMembership?.name ?? desired.sharedNetworkMembership?.name ?? "membership"}.`,
      ),
    );
  const aliases = <T>(current: Readonly<Record<string, T>>, previous: Readonly<Record<string, T>>) =>
    Object.fromEntries([
      ...Object.entries(current).filter(([id]) => !retained.has(id)),
      ...Object.entries(previous).filter(([id]) => retained.has(id)),
    ]);
  const authored = new Map(
    (desired.authoredNetworks ?? []).map((network) => [
      network.name,
      {
        ...network,
        members: Object.fromEntries(Object.entries(network.members).filter(([id]) => !retained.has(id))),
      },
    ]),
  );
  for (const network of prior.authoredNetworks ?? []) {
    const members = Object.fromEntries(Object.entries(network.members).filter(([id]) => retained.has(id)));
    if (Object.keys(members).length === 0) continue;
    const current = authored.get(network.name);
    if (
      current !== undefined &&
      canonicalJson({ ...current, members: undefined }) !== canonicalJson({ ...network, members: undefined })
    )
      return yield* Effect.fail(
        conflict(
          `Global services ${Object.keys(members).join(", ")} have incompatible definitions for network ${network.name}.`,
        ),
      );
    authored.set(network.name, { ...network, members: { ...current?.members, ...members } });
  }
  return {
    perAppBridge:
      desired.perAppBridge === null
        ? null
        : {
            ...desired.perAppBridge,
            aliases: aliases(desired.perAppBridge.aliases ?? {}, prior.perAppBridge?.aliases ?? {}),
          },
    ...(desired.sharedNetworkMembership === undefined
      ? {}
      : {
          sharedNetworkMembership: {
            ...desired.sharedNetworkMembership,
            aliases: aliases(
              desired.sharedNetworkMembership.aliases,
              prior.sharedNetworkMembership?.aliases ?? {},
            ),
          },
        }),
    authoredNetworks: [...authored.values()].filter((network) => Object.keys(network.members).length > 0),
  } satisfies NetworkingPlan;
});

/** Route references belong to the recorded route table, even when services were built separately. */
const remapGlobalRouteReferences = Effect.fn("GlobalApp.remapRouteReferences")(function* (
  services: AppPlan["services"],
  routeRefs: ReadonlyArray<ServicePlan["routes"]>,
) {
  return Object.fromEntries(
    yield* Effect.forEach(Object.entries(services), ([id, service]) =>
      Effect.gen(function* () {
        const routes: Array<ServicePlan["routes"][number]> = [];
        for (const ref of service.routes) {
          const mapped = routeRefs[ref.index];
          if (mapped === undefined || mapped.length === 0)
            return yield* Effect.fail(
              conflict(`Global service ${id} has a route reference absent from the recorded route table.`),
            );
          routes.push(...mapped);
        }
        return [id, { ...service, routes }] as const;
      }),
    ),
  );
});

export const composeGlobalRecordedPlan = Effect.fn("GlobalApp.composeRecordedPlan")(function* (
  desired: AppPlan,
  prior: AppPlan,
  retained: ReadonlySet<string>,
  active: ReadonlySet<string>,
  disabled: ReadonlySet<string>,
) {
  const accumulator = makeRouteAccumulator();
  const routeRefs: Array<ServicePlan["routes"]> = desired.routes.map(() => []);
  const priorIndexes = new Map<number, ReadonlyArray<number>>();
  for (const [index, route] of desired.routes.entries()) {
    if (!Object.hasOwn(desired.services, route.service) || retained.has(String(route.service))) continue;
    const refs = yield* accumulator
      .add(route, { key: `selected global route ${route.hostname}` })
      .pipe(mapFailures((cause) => conflict(cause.message)));
    routeRefs[index] = refs;
  }
  for (const [index, route] of prior.routes.entries()) {
    const id = String(route.service);
    if (!retained.has(id) || !active.has(id) || disabled.has(id)) continue;
    const refs = yield* accumulator
      .add(route, { key: `retained global route for ${id}` })
      .pipe(mapFailures((cause) => conflict(cause.message)));
    priorIndexes.set(
      index,
      refs.map((ref) => ref.index),
    );
  }
  const currentServices = yield* remapGlobalRouteReferences(
    Object.fromEntries(Object.entries(desired.services).filter(([id]) => !retained.has(id))),
    routeRefs,
  );
  const services: AppPlan["services"] = {
    ...currentServices,
    ...Object.fromEntries(
      Object.entries(prior.services)
        .filter(([id]) => retained.has(id))
        .map(([id, service]) => [
          id,
          {
            ...service,
            routes: service.routes.flatMap((ref) =>
              (priorIndexes.get(ref.index) ?? []).map((index) => ({ index })),
            ),
          },
        ]),
    ),
  };
  const stores = new Map(desired.stores.map((store) => [store.name, store]));
  const retainedStores = new Set(
    Object.values(prior.services)
      .filter((service) => retained.has(String(service.name)))
      .flatMap((service) =>
        service.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.store] : [])),
      ),
  );
  for (const store of prior.stores) {
    if (!retainedStores.has(store.name)) continue;
    const current = stores.get(store.name);
    if (current !== undefined && canonicalJson(current) !== canonicalJson(store)) {
      const users = [...retained].filter((id) =>
        Object.values(prior.services).some(
          (service) =>
            service.name === id &&
            service.mounts.some((mount) => mount.type === "volume" && mount.store === store.name),
        ),
      );
      return yield* Effect.fail(
        conflict(
          `Global services ${users.join(", ")} have incompatible definitions for data store ${store.name}.`,
        ),
      );
    }
    stores.set(store.name, store);
  }
  const networking = yield* retainedNetworking(desired.networking, prior.networking, retained);
  const plan: AppPlan = {
    ...desired,
    services,
    routes: accumulator.routes,
    stores: [...stores.values()],
    ...(networking === undefined ? {} : { networking }),
    fileSync: [
      ...desired.fileSync.filter((entry) => !retained.has(String(entry.session.service))),
      ...prior.fileSync.filter((entry) => retained.has(String(entry.session.service))),
    ],
    ...(desired.fileSyncPolicy === undefined
      ? {}
      : {
          fileSyncPolicy: {
            ...desired.fileSyncPolicy,
            services: {
              ...Object.fromEntries(
                Object.entries(desired.fileSyncPolicy.services).filter(([id]) => !retained.has(id)),
              ),
              ...Object.fromEntries(
                Object.entries(prior.fileSyncPolicy?.services ?? {}).filter(([id]) => retained.has(id)),
              ),
            },
          },
        }),
  };
  return plan;
});

/**
 * Advance metadata only for the group the provider is about to apply. Siblings that group removes
 * stop being retained; every other sibling keeps its recorded metadata until its own group succeeds.
 */
export const advanceGlobalRecordedPlan = Effect.fn("GlobalApp.advanceRecordedPlan")(function* (
  recorded: AppPlan,
  built: AppPlan,
  disabledIds: ReadonlyArray<string>,
  removedIds: ReadonlySet<string> = new Set(),
) {
  const selected = new Set(Object.keys(built.services));
  const retained = new Set(
    Object.keys(recorded.services).filter((id) => !selected.has(id) && !removedIds.has(id)),
  );
  return yield* composeGlobalRecordedPlan(
    selectGlobalPlan(built, selected),
    recorded,
    retained,
    new Set(recorded.routes.map((route) => String(route.service))),
    new Set(disabledIds),
  );
});
