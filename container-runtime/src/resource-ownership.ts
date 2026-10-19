import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ResourceOwnership,
  ServiceName,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { isSharedNetwork } from "./native-ownership.ts";
import { serviceContainerName } from "./plan.ts";
import { podmanNetworkNames } from "./podman/networks.ts";
import { volumeClassForStore } from "./volume-classes.ts";
import { planVolumeOwnership } from "./volume-ownership.ts";

const ResourceOwner = Schema.Struct({
  nativeName: Schema.String,
  appId: AppId,
  appRoot: AbsolutePath,
  ownerKey: Schema.String,
  providerId: ProviderId,
});
const ContainerIdentity = Schema.Struct({
  ...ResourceOwner.fields,
  kind: Schema.Literal("container"),
  service: ServiceName,
});
const NetworkIdentity = Schema.Struct({ ...ResourceOwner.fields, kind: Schema.Literal("network") });
const VolumeIdentity = Schema.Struct({
  ...ResourceOwner.fields,
  kind: Schema.Literal("volume"),
  volumeClass: Schema.Literals(["data", "cache"]),
  volumeScope: Schema.Literals(["app", "service", "global"]),
});
const ResourceIdentity = Schema.Union([ContainerIdentity, NetworkIdentity, VolumeIdentity]);
export const OwnedResource = Schema.Union([
  Schema.Struct({ ...ContainerIdentity.fields, identityDigest: Schema.String }),
  Schema.Struct({ ...NetworkIdentity.fields, identityDigest: Schema.String }),
  Schema.Struct({ ...VolumeIdentity.fields, identityDigest: Schema.String }),
]);
export type OwnedResource = typeof OwnedResource.Type;
const Inventory = Schema.Struct({ ...ResourceOwnership.fields, resources: Schema.Array(OwnedResource) });
export type ResourceInventory = typeof Inventory.Type;

export const ownershipFailure = (providerId: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId,
    operation: "resource-ownership",
    message: "Resource ownership inventory could not be verified or persisted.",
    remediation: "Repair the provider plugin state and retry cleanup before starting this app.",
    ...(cause === undefined ? {} : { cause }),
  });

const digest = (resource: typeof ResourceIdentity.Type) => sha256Hex(canonicalJson(resource));
const identify = (resource: typeof ResourceIdentity.Type): OwnedResource => ({
  ...resource,
  identityDigest: digest(resource),
});
const keyFor = (resource: OwnedResource) => resource.identityDigest;

const validate = (inventory: ResourceInventory, root: AbsolutePath, providerId: string) => {
  const owner = planVolumeOwnership({ root });
  if (
    inventory.appRoot !== root ||
    inventory.ownerKey !== owner.ownerKey ||
    inventory.providerId !== providerId
  )
    throw ownershipFailure(providerId);
  const appIds = new Set(inventory.resources.map((resource) => resource.appId));
  if (inventory.appIds.length !== appIds.size || inventory.appIds.some((id) => !appIds.has(id)))
    throw ownershipFailure(providerId);
  for (const resource of inventory.resources) {
    const { identityDigest, ...identity } = resource;
    if (
      resource.appRoot !== root ||
      resource.ownerKey !== owner.ownerKey ||
      resource.providerId !== providerId ||
      (resource.kind === "network" && isSharedNetwork({}, resource.nativeName)) ||
      identityDigest !== digest(identity) ||
      !inventory.appIds.includes(resource.appId)
    )
      throw ownershipFailure(providerId);
  }
  return inventory;
};

export const makeResourceOwnershipStore = (providerId: string, state?: PluginStateStore) => {
  const open = (root: AbsolutePath) =>
    state === undefined
      ? Effect.fail(ownershipFailure(providerId))
      : state
          .open({
            namespace: "resource-ownership",
            key: `${planVolumeOwnership({ root }).ownerKey}.json`,
            schema: Inventory,
            version: 1,
            codec: "json",
            mode: 0o600,
            lock: "advisory",
            onCorrupt: "fail",
            onVersionMismatch: (_raw, version): ResourceInventory => {
              throw new StateStoreError({
                reason: "version",
                operation: "resource-ownership",
                cause: version,
              });
            },
          })
          .pipe(Effect.mapError((cause) => ownershipFailure(providerId, cause)));
  const load = Effect.fn("ResourceOwnership.load")(function* (root: AbsolutePath) {
    const bucket = yield* open(root);
    const value = yield* bucket.get.pipe(Effect.mapError((cause) => ownershipFailure(providerId, cause)));
    return yield* Effect.try({
      try: () => (value === null ? undefined : validate(value, root, providerId)),
      catch: (cause) => ownershipFailure(providerId, cause),
    });
  });
  const prepare = Effect.fn("ResourceOwnership.prepare")(function* (plan: AppPlan, previous?: AppPlan) {
    const owner = planVolumeOwnership(plan);
    const root = owner.appRoot;
    if (
      plan.root !== root ||
      owner.ownerKey !== planVolumeOwnership({ root }).ownerKey ||
      plan.provider !== providerId
    )
      return yield* Effect.fail(ownershipFailure(providerId));
    const resources: OwnedResource[] = [];
    for (const attempt of previous === undefined ? [plan] : [previous, plan]) {
      const attemptOwner = planVolumeOwnership(attempt);
      if (
        attempt.root !== root ||
        attempt.provider !== providerId ||
        attemptOwner.appRoot !== root ||
        attemptOwner.ownerKey !== owner.ownerKey
      )
        return yield* Effect.fail(ownershipFailure(providerId));
      const identity = { ...owner, appId: attempt.id, providerId: attempt.provider };
      for (const service of Object.values(attempt.services))
        resources.push(
          identify({
            ...identity,
            kind: "container",
            nativeName: serviceContainerName(attempt, service.name),
            service: service.name,
          }),
        );
      for (const name of podmanNetworkNames(attempt)) {
        if (!isSharedNetwork(attempt, name))
          resources.push(identify({ ...identity, kind: "network", nativeName: name }));
      }
      for (const store of attempt.stores)
        resources.push(
          identify({
            ...identity,
            kind: "volume",
            nativeName: store.name,
            volumeClass: volumeClassForStore(store),
            volumeScope: store.scope,
          }),
        );
    }
    const bucket = yield* open(root);
    yield* bucket
      .modify((current) => {
        if (current !== null) validate(current, root, providerId);
        const union = [
          ...new Map(
            [...(current?.resources ?? []), ...resources].map((item) => [keyFor(item), item]),
          ).values(),
        ];
        return [
          undefined,
          {
            ...owner,
            providerId: plan.provider,
            appIds: [...new Set(union.map((item) => item.appId))],
            resources: union,
          },
        ];
      })
      .pipe(Effect.mapError((cause) => ownershipFailure(providerId, cause)));
  });
  const retire = Effect.fn("ResourceOwnership.retire")(function* (
    root: AbsolutePath,
    resource: OwnedResource,
  ) {
    const bucket = yield* open(root);
    yield* bucket
      .modify((current) => {
        if (current === null) throw ownershipFailure(providerId);
        validate(current, root, providerId);
        const resources = current.resources.filter((item) => keyFor(item) !== keyFor(resource));
        return [
          undefined,
          { ...current, resources, appIds: [...new Set(resources.map((item) => item.appId))] },
        ];
      })
      .pipe(Effect.mapError((cause) => ownershipFailure(providerId, cause)));
  });
  return {
    load,
    prepare,
    retire,
    summary: (root: AbsolutePath) =>
      load(root).pipe(
        Effect.map((inventory): ResourceOwnership | undefined =>
          inventory === undefined || inventory.resources.length === 0
            ? undefined
            : {
                appRoot: inventory.appRoot,
                ownerKey: inventory.ownerKey,
                providerId: inventory.providerId,
                appIds: inventory.appIds,
              },
        ),
      ),
  };
};
