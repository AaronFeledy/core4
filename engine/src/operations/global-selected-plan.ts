import type { AppPlan } from "@lando/sdk/schema";

export const selectGlobalPlan = (plan: AppPlan, ids: ReadonlySet<string>): AppPlan => {
  const services = Object.fromEntries(Object.entries(plan.services).filter(([id]) => ids.has(id)));
  const stores = new Set(
    Object.values(services).flatMap((service) =>
      service.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.store] : [])),
    ),
  );
  const networking = plan.networking;
  const selectMembers = <T>(members: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.entries(members).filter(([id]) => ids.has(id)));
  return {
    ...plan,
    services,
    stores: plan.stores.filter((store) => stores.has(store.name)),
    fileSync: plan.fileSync.filter((entry) => ids.has(String(entry.session.service))),
    ...(plan.fileSyncPolicy === undefined
      ? {}
      : {
          fileSyncPolicy: { ...plan.fileSyncPolicy, services: selectMembers(plan.fileSyncPolicy.services) },
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
                    aliases: selectMembers(networking.perAppBridge.aliases ?? {}),
                  },
            ...(networking.sharedNetworkMembership === undefined
              ? {}
              : {
                  sharedNetworkMembership: {
                    ...networking.sharedNetworkMembership,
                    aliases: selectMembers(networking.sharedNetworkMembership.aliases),
                  },
                }),
            authoredNetworks: (networking.authoredNetworks ?? [])
              .map((network) => ({
                ...network,
                members: selectMembers(network.members),
              }))
              .filter((network) => Object.keys(network.members).length > 0),
          },
        }),
  };
};
