import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ResourceOwnership,
  ServiceName,
  landoOwnedNetworkNames,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { Schema } from "effect";
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
export const RESOURCE_OWNERSHIP_VERSION = 1;
export const ResourceOwnershipInventory = Schema.Struct({
  ...ResourceOwnership.fields,
  resources: Schema.Array(OwnedResource),
});
export type ResourceInventory = typeof ResourceOwnershipInventory.Type;

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

export const resourcesForPlan = (plan: AppPlan): OwnedResource[] => {
  const owner = planAppIdentity(plan);
  const identity = {
    appRoot: owner.appRoot,
    ownerKey: owner.ownerKey,
    appId: plan.id,
    providerId: plan.provider,
  };
  const resources: OwnedResource[] = [];
  const scratchId = scratchLabelsForPlan(plan)[SCRATCH_ID_LABEL];
  for (const service of Object.values(plan.services))
    resources.push(
      identify({
        ...identity,
        kind: "container",
        nativeName: serviceContainerName(plan, service.name),
        service: service.name,
      }),
    );
  for (const name of landoOwnedNetworkNames(plan)) {
    const authored = plan.networking?.authoredNetworks?.some(
      (network) => !network.external && network.name === name,
    );
    if (!isSharedNetwork(plan, name))
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
  for (const store of plan.stores)
    resources.push(
      identify({
        ...identity,
        kind: "volume",
        appId: planDataId(plan),
        nativeName: store.name,
        volumeClass: volumeClassForStore(store),
        volumeScope: store.scope,
      }),
    );
  return resources;
};

export const validate = (inventory: ResourceInventory, root: AbsolutePath, providerId: string) => {
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
