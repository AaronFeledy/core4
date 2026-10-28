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
  landoOwnedNetworkNames,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { SCRATCH_ID_LABEL, scratchLabelsForPlan } from "./labels.ts";
import { isSharedNetwork } from "./native-ownership.ts";
import { serviceContainerName } from "./plan.ts";
import { volumeClassForStore } from "./volume-classes.ts";

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
const NetworkIdentity = Schema.Struct({
  ...ResourceOwner.fields,
  kind: Schema.Literal("network"),
  role: Schema.optionalKey(Schema.Literal("authored")),
  scratchId: Schema.optionalKey(AppId),
});
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
  const owner = planAppIdentity({ root });
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
      (resource.kind === "network" &&
        resource.scratchId !== undefined &&
        resource.scratchId !== resource.appId) ||
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
            key: `${planAppIdentity({ root }).ownerKey}.json`,
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
                remediation:
                  "Upgrade Lando or clear the resource-ownership state written by an incompatible build.",
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
    const owner = planAppIdentity(plan);
    const root = owner.appRoot;
    if (
      plan.root !== root ||
      owner.ownerKey !== planAppIdentity({ root }).ownerKey ||
      plan.provider !== providerId
    )
      return yield* Effect.fail(ownershipFailure(providerId));
    const resources: OwnedResource[] = [];
    for (const attempt of previous === undefined ? [plan] : [previous, plan]) {
      const attemptOwner = planAppIdentity(attempt);
      if (
        attempt.root !== root ||
        attempt.provider !== providerId ||
        attemptOwner.appRoot !== root ||
        attemptOwner.ownerKey !== owner.ownerKey
      )
        return yield* Effect.fail(ownershipFailure(providerId));
      // Only persisted owner fields enter the digest; an identity's repoGroupKey is never stored.
      const identity = {
        appRoot: root,
        ownerKey: owner.ownerKey,
        appId: attempt.id,
        providerId: attempt.provider,
      };
      const scratchId = scratchLabelsForPlan(attempt)[SCRATCH_ID_LABEL];
      for (const service of Object.values(attempt.services))
        resources.push(
          identify({
            ...identity,
            kind: "container",
            nativeName: serviceContainerName(attempt, service.name),
            service: service.name,
          }),
        );
      for (const name of landoOwnedNetworkNames(attempt)) {
        const authored = attempt.networking?.authoredNetworks?.some(
          (network) => !network.external && network.name === name,
        );
        if (!isSharedNetwork(attempt, name))
          resources.push(
            identify({
              ...identity,
              kind: "network",
              nativeName: name,
              ...(authored ? { role: "authored" as const } : {}),
              ...(scratchId === undefined ? {} : { scratchId: AppId.make(scratchId) }),
            }),
          );
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
        const networkSlot = (item: OwnedResource) =>
          item.kind === "network"
            ? canonicalJson({
                appRoot: item.appRoot,
                ownerKey: item.ownerKey,
                providerId: item.providerId,
                appId: item.appId,
                nativeName: item.nativeName,
                role: item.role ?? null,
              })
            : undefined;
        const finalScratchId = scratchLabelsForPlan(plan)[SCRATCH_ID_LABEL];
        const finalNetworkNames = new Set(
          landoOwnedNetworkNames(plan).filter((name) => !isSharedNetwork(plan, name)),
        );
        const finalScratchSlots = new Set(
          finalScratchId === undefined
            ? []
            : resources
                .filter(
                  (item) =>
                    item.kind === "network" &&
                    item.scratchId === finalScratchId &&
                    finalNetworkNames.has(item.nativeName) &&
                    (item.role === "authored") ===
                      !!plan.networking?.authoredNetworks?.some(
                        (network) => !network.external && network.name === item.nativeName,
                      ),
                )
                .map((item) => networkSlot(item)),
        );
        const unionByKey = new Map<string, OwnedResource>();
        for (const item of [...(current?.resources ?? []), ...resources]) {
          const slot = networkSlot(item);
          const key = slot === undefined ? `resource:${keyFor(item)}` : `network:${slot}`;
          const existing = unionByKey.get(key);
          if (slot !== undefined && existing?.kind === "network" && item.kind === "network") {
            if (existing.scratchId !== undefined && item.scratchId === undefined) {
              // A prior scratch proof cannot be downgraded by an ordinary plan.
              // A previous ordinary attempt is allowed only when the final plan restores proof.
              if (!finalScratchSlots.has(slot)) throw ownershipFailure(providerId);
              continue;
            }
            if (
              existing.scratchId !== undefined &&
              item.scratchId !== undefined &&
              existing.scratchId !== item.scratchId
            )
              throw ownershipFailure(providerId);
          }
          unionByKey.set(key, item);
        }
        const union = [...unionByKey.values()];
        return [
          undefined,
          {
            appRoot: root,
            ownerKey: owner.ownerKey,
            providerId: plan.provider,
            appIds: [...new Set(union.map((item) => item.appId))],
            resources: union,
          },
        ];
      })
      .pipe(
        Effect.mapError((cause) => ownershipFailure(providerId, cause)),
        Effect.catchDefect((defect) =>
          Schema.is(ProviderUnavailableError)(defect) ? Effect.fail(defect) : Effect.die(defect),
        ),
      );
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
