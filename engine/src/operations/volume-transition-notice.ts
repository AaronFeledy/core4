import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan, DataStorePlan, ServiceHomePlan, ServicePlan } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { Context, DateTime, Effect } from "effect";

const VolumeTransitionNotices = Context.Reference<Set<string> | undefined>(
  "@lando/engine/VolumeTransitionNotices",
  {
    defaultValue: () => undefined,
  },
);

export const withVolumeTransitionNotices = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const notices = yield* VolumeTransitionNotices;
  return yield* notices === undefined
    ? Effect.provideService(effect, VolumeTransitionNotices, new Set<string>())
    : effect;
});

const unknownReason = (
  service: ServicePlan,
  home: Extract<ServiceHomePlan, { state: "unknown" }>,
): string => {
  switch (home.reason) {
    case "custom-image":
      return "its image now comes from your Landofile";
    case "no-identity":
      return `${service.type} doesn't declare image users`;
    case "undeclared-user":
      return `${service.type} doesn't know where ${home.user ?? "the planned user"}'s home is`;
    default: {
      const unreachable: never = home.reason;
      return unreachable;
    }
  }
};

const dataVolumes = (service: ServicePlan, stores: ReadonlyMap<string, DataStorePlan>) => {
  const volumes = new Map<string, { readonly store: string; readonly target: string }>();
  for (const mount of service.mounts) {
    if (mount.type !== "volume") continue;
    const store = stores.get(mount.store);
    if (store?.kind === "cache" || store?.scope === "global") continue;
    switch (mount.origin) {
      case "service":
        volumes.set(mount.target, mount);
        break;
      case "authored":
      case undefined:
        if (store?.kind === "data") volumes.set(mount.target, mount);
        break;
      case "derived":
      case "integration":
        break;
      default: {
        const unreachable: never = mount.origin;
        return unreachable;
      }
    }
  }
  const home = service.home;
  if (home?.state === "persisted") {
    const store = stores.get(home.store);
    if (store?.kind !== "cache" && store?.scope !== "global") volumes.set(home.target, home);
  }
  return volumes;
};

export const publishVolumeTransitionNotices = Effect.fn("AppOperation.volumeTransitionNotices")(function* (
  applied: AppPlan | undefined,
  desired: AppPlan,
) {
  if (applied === undefined) return;
  const notices = yield* VolumeTransitionNotices;
  const events = yield* EventService;
  const appliedStores = new Map(applied.stores.map((store) => [store.name, store]));
  const desiredStores = new Map(desired.stores.map((store) => [store.name, store]));
  for (const service of Object.values(desired.services)) {
    const previous = applied.services[service.name];
    if (previous === undefined) continue;
    const desiredVolumes = dataVolumes(service, desiredStores);
    for (const old of dataVolumes(previous, appliedStores).values()) {
      let message: string;
      if (
        previous.home?.state === "persisted" &&
        previous.home.target === old.target &&
        previous.home.store === old.store
      ) {
        const home = service.home;
        if (home === undefined) continue;
        switch (home.state) {
          case "unknown":
            message = `Service ${service.name} will no longer keep its home at ${old.target}: ${unknownReason(service, home)}.`;
            break;
          case "persisted":
            if (home.store === old.store && home.target === old.target) continue;
            message = `Service ${service.name} will use home volume ${home.store} at ${home.target} (previously ${old.store} at ${old.target}).`;
            break;
          case "disabled":
          case "authored":
            continue;
          default: {
            const unreachable: never = home;
            return unreachable;
          }
        }
      } else {
        const next = desiredVolumes.get(old.target);
        if (next?.store === old.store) continue;
        message =
          next === undefined
            ? `Service ${service.name} will no longer mount volume ${old.store} at ${old.target}.`
            : `Service ${service.name} will use volume ${next.store} at ${next.target} (previously ${old.store} at ${old.target}).`;
      }
      const key = `${desired.root}\0${service.name}\0${old.target}`;
      if (notices?.has(key)) continue;
      notices?.add(key);
      const storage = `storage: [{ store: ${quoteYamlScalar(old.store)}, target: ${quoteYamlScalar(old.target)} }]`;
      const sameType =
        previous.serviceTypeId !== undefined &&
        service.serviceTypeId !== undefined &&
        previous.serviceTypeId === service.serviceTypeId;
      const advice = sameType
        ? `To mount it at its previous location, set ${storage} under services.${service.name} in your Landofile.`
        : `${
            previous.serviceTypeId === undefined || service.serviceTypeId === undefined
              ? "Service-type compatibility is unverified because a recorded declaration identity is missing."
              : `The service type changed from ${previous.serviceTypeId} to ${service.serviceTypeId}.`
          }
Export the data from the old service first, then import it using the new service's supported tools.`;
      yield* events.publish(
        MessageWarnEvent.make({
          body: `${message}\nLando leaves ${old.store} untouched. ${advice}`,
          timestamp: DateTime.nowUnsafe(),
        }),
      );
    }
  }
});

export const publishPlacementVolumeTransitionNotices = Effect.fn(
  "AppOperation.placementVolumeTransitionNotices",
)(function* (
  placement: { readonly plan: AppPlan | undefined; readonly superseded: readonly AppPlan[] },
  desired: AppPlan,
) {
  for (const applied of [
    ...(placement.plan === undefined ? [] : [placement.plan]),
    ...placement.superseded,
  ]) {
    yield* publishVolumeTransitionNotices(applied, desired);
  }
});
