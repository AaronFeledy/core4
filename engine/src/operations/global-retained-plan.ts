import { canonicalJson } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import type { AppPlan, NetworkingPlan, ServicePlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { resolveGlobalPlacement } from "../global-app/placement.ts";
import { readGlobalResolution } from "../global-app/resolution.ts";
import { makeRouteAccumulator } from "../planner/route-identity.ts";

const conflict = (message: string) =>
  new GlobalAppError({
    operation: "start",
    message,
    remediation:
      "Include the affected sibling in the start selection, or make the shared resource definitions consistent before retrying.",
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
        "Selected global startup cannot replace unknown networking metadata while an unselected sibling still exists.",
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
      conflict("Selected global startup changes a network still used by an unselected sibling."),
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
        conflict(`Global network ${network.name} has incompatible definitions for an unselected sibling.`),
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

const composeGlobalRecordedPlan = Effect.fn("GlobalApp.composeRecordedPlan")(function* (
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
      .pipe(Effect.mapError((cause) => conflict(cause.message)));
    routeRefs[index] = refs;
  }
  for (const [index, route] of prior.routes.entries()) {
    const id = String(route.service);
    if (!retained.has(id) || !active.has(id) || disabled.has(id)) continue;
    const refs = yield* accumulator
      .add(route, { key: `retained global route for ${id}` })
      .pipe(Effect.mapError((cause) => conflict(cause.message)));
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
    if (current !== undefined && canonicalJson(current) !== canonicalJson(store))
      return yield* Effect.fail(
        conflict(
          `Global data store ${store.name} has incompatible definitions while an unselected sibling still uses it.`,
        ),
      );
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

const selectPlan = (plan: AppPlan, ids: ReadonlySet<string>): AppPlan => {
  const services = Object.fromEntries(Object.entries(plan.services).filter(([id]) => ids.has(id)));
  const stores = new Set(
    Object.values(services).flatMap((service) =>
      service.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.store] : [])),
    ),
  );
  const networking = plan.networking;
  return {
    ...plan,
    services,
    stores: plan.stores.filter((store) => stores.has(store.name)),
    fileSync: plan.fileSync.filter((entry) => ids.has(String(entry.session.service))),
    ...(plan.fileSyncPolicy === undefined
      ? {}
      : {
          fileSyncPolicy: {
            ...plan.fileSyncPolicy,
            services: Object.fromEntries(
              Object.entries(plan.fileSyncPolicy.services).filter(([id]) => ids.has(id)),
            ),
          },
        }),
    ...(networking === undefined
      ? {}
      : {
          networking: {
            ...networking,
            perAppBridge:
              networking.perAppBridge === null
                ? null
                : {
                    ...networking.perAppBridge,
                    aliases: Object.fromEntries(
                      Object.entries(networking.perAppBridge.aliases ?? {}).filter(([id]) => ids.has(id)),
                    ),
                  },
            ...(networking.sharedNetworkMembership === undefined
              ? {}
              : {
                  sharedNetworkMembership: {
                    ...networking.sharedNetworkMembership,
                    aliases: Object.fromEntries(
                      Object.entries(networking.sharedNetworkMembership.aliases).filter(([id]) =>
                        ids.has(id),
                      ),
                    ),
                  },
                }),
            authoredNetworks: (networking.authoredNetworks ?? [])
              .map((network) => ({
                ...network,
                members: Object.fromEntries(Object.entries(network.members).filter(([id]) => ids.has(id))),
              }))
              .filter((network) => Object.keys(network.members).length > 0),
          },
        }),
  };
};

/** Advance metadata only for the group the provider is about to apply. */
export const advanceGlobalRecordedPlan = Effect.fn("GlobalApp.advanceRecordedPlan")(function* (
  recorded: AppPlan,
  built: AppPlan,
  disabledIds: ReadonlyArray<string>,
) {
  const selected = new Set(Object.keys(built.services));
  const retained = new Set(Object.keys(recorded.services).filter((id) => !selected.has(id)));
  return yield* composeGlobalRecordedPlan(
    selectPlan(built, selected),
    recorded,
    retained,
    new Set(recorded.routes.map((route) => String(route.service))),
    new Set(disabledIds),
  );
});

/** Preserve observed siblings in metadata; desired configuration alone controls execution. */
export const retainGlobalPlanSiblings = Effect.fn("GlobalApp.retainPlanSiblings")(function* (
  desired: AppPlan,
  provider: RuntimeProviderShape,
  selectedIds: ReadonlyArray<string>,
) {
  const { plan: prior } = yield* resolveGlobalPlacement();
  if (prior !== undefined && (prior.provider !== desired.provider || prior.root !== desired.root))
    return yield* Effect.fail(
      conflict("Prior global applied state does not match selected startup placement."),
    );
  if (provider.ensureReady !== undefined) yield* provider.ensureReady;
  const observed = yield* provider.list({ app: desired.id, includeUnplanned: true });
  const selected = new Set(selectedIds);
  const priorNames = new Set(Object.keys(prior?.services ?? {}));
  const activeStatus = (status: string) => ["running", "paused", "restarting"].includes(status);
  if (
    observed.some(
      (service) =>
        service.app === desired.id &&
        !selected.has(String(service.service)) &&
        activeStatus(service.status) &&
        (service.appRoot === undefined ||
          (service.appRoot === desired.root &&
            (service.providerId !== desired.provider ||
              service.containerId === undefined ||
              !priorNames.has(String(service.service))))),
    )
  )
    return yield* Effect.fail(
      conflict(
        "An active unselected global service lacks matching applied ownership metadata; restore its state before selected startup.",
      ),
    );
  const owned = observed.filter(
    (service) =>
      service.app === desired.id &&
      service.appRoot === desired.root &&
      service.providerId === desired.provider &&
      service.containerId !== undefined &&
      priorNames.has(String(service.service)),
  );
  const observedIds = new Set(owned.map((service) => String(service.service)));
  const retained = new Set([...observedIds].filter((id) => !selected.has(id)));
  const active = new Set(
    owned.filter((service) => activeStatus(service.status)).map((service) => String(service.service)),
  );
  const resolution = yield* readGlobalResolution({
    providerId: desired.provider,
    providerCapabilities: provider.capabilities,
  });
  const disabledIds = resolution.entries.filter((entry) => !entry.enabled).map((entry) => entry.id);
  const disabled = new Set(disabledIds);
  const base = prior ?? desired;
  const empty = { ...selectPlan(base, new Set()), routes: [] };
  const recordedPlan =
    prior === undefined
      ? empty
      : yield* composeGlobalRecordedPlan(empty, prior, observedIds, active, disabled);
  const expected = yield* composeGlobalRecordedPlan(
    selectPlan(desired, selected),
    recordedPlan,
    retained,
    active,
    disabled,
  );
  return { plan: expected, recordedPlan, disabledIds, retainedIds: [...retained].sort() };
});
