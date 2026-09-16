import { Effect, Schema } from "effect";

import type { VolumeOperationError } from "@lando/sdk/errors";
import { type AppIdentity, type VolumeInfo, VolumeLocator, type VolumeRef } from "@lando/sdk/schema";

import {
  type MountedVolumeTarget,
  type NativeVolume,
  NativeVolumeSchema,
  type VolumeAdoptionTarget,
  type VolumeObservationProvider,
  adoptNativeVolumeWitness,
  resolveNativeVolumeIdentity,
  volumeCoordinationKey,
  volumeObservationFailure,
} from "./native-volume-identity.ts";

export {
  type MountedVolumeTarget,
  type NativeVolumeIdentityResolution,
  type VolumeAdoptionTarget,
  resolveNativeVolumeIdentity,
} from "./native-volume-identity.ts";

export const volumeCreationOwnerLabels = (
  identity: AppIdentity | undefined,
): Readonly<Record<string, string>> =>
  identity === undefined ? {} : { "dev.lando.volume-owner": identity.appRoot };

const Mount = Schema.Struct({
  Type: Schema.String,
  Destination: Schema.String,
  Name: Schema.optional(Schema.String),
});
const Container = Schema.Struct({ Mounts: Schema.Array(Mount) });
const resolveMountedVolume = (provider: VolumeObservationProvider, target: MountedVolumeTarget) =>
  Effect.gen(function* () {
    const request = provider.api.request;
    if (request === undefined) return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const containerResponse = yield* request({
      method: "GET",
      path: `/containers/${encodeURIComponent(target.containerId)}/json`,
    });
    if (containerResponse.status !== 200)
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const container = yield* Schema.decodeUnknown(Schema.parseJson(Container))(containerResponse.body);
    const matches = container.Mounts.filter((mount) => mount.Destination === target.destination);
    const mount = matches[0];
    if (matches.length !== 1 || mount?.Type !== "volume" || !mount.Name) {
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    }
    const response = yield* request({ method: "GET", path: `/volumes/${encodeURIComponent(mount.Name)}` });
    if (response.status !== 200) return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const volume = yield* Schema.decodeUnknown(Schema.parseJson(NativeVolumeSchema))(response.body);
    if (volume.Name !== mount.Name) return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    return volume;
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId)));

export const locateVolume = (
  provider: VolumeObservationProvider,
  ref: VolumeRef,
): Effect.Effect<typeof VolumeLocator.Type, VolumeOperationError> =>
  Effect.gen(function* () {
    const endpointNamespace = provider.endpointNamespace;
    const request = provider.api.request;
    if (endpointNamespace === undefined || request === undefined) {
      return yield* Effect.fail(volumeObservationFailure(provider.providerId, "locateVolume"));
    }
    const key = JSON.stringify([`endpoint:${endpointNamespace}`, ref.store]);
    const response = yield* request({ method: "GET", path: `/volumes/${encodeURIComponent(ref.store)}` });
    if (response.status === 404) {
      return yield* Schema.decodeUnknown(VolumeLocator)({ coordinationKey: key, nativeName: ref.store });
    }
    if (response.status !== 200)
      return yield* Effect.fail(volumeObservationFailure(provider.providerId, "locateVolume"));
    const volume = yield* Schema.decodeUnknown(Schema.parseJson(NativeVolumeSchema))(response.body);
    if (volume.Name !== ref.store)
      return yield* Effect.fail(volumeObservationFailure(provider.providerId, "locateVolume"));
    const resolution = yield* resolveNativeVolumeIdentity(provider, volume, { _tag: "named" });
    return yield* Schema.decodeUnknown(VolumeLocator)({
      coordinationKey: key,
      nativeName: volume.Name,
      ...(resolution.identity === undefined ? {} : { identity: resolution.identity }),
    });
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId, "locateVolume")));

export const volumeInfo = (target: MountedVolumeTarget, volume: NativeVolume): VolumeInfo => {
  const instanceId = volume.Labels?.["dev.lando.volume-instance"];
  return {
    ref: { app: target.app, store: volume.Name },
    ...(instanceId ? { instanceId, provenance: "known" as const } : { provenance: "legacy" as const }),
    ...(volume.Labels == null ? {} : { labels: volume.Labels }),
  };
};

export const observeMountedVolume = (
  provider: VolumeObservationProvider,
  target: MountedVolumeTarget,
): Effect.Effect<VolumeInfo, VolumeOperationError> =>
  Effect.gen(function* () {
    const volume = yield* resolveMountedVolume(provider, target);
    const base = volumeInfo(target, volume);
    const resolution = yield* resolveNativeVolumeIdentity(provider, volume, { _tag: "mounted", target });
    return resolution.identity === undefined ? base : { ...base, identity: resolution.identity };
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId)));

export const adoptMountedVolume = (
  provider: VolumeObservationProvider,
  target: VolumeAdoptionTarget,
): Effect.Effect<VolumeInfo, VolumeOperationError> =>
  Effect.gen(function* () {
    const volume = yield* resolveMountedVolume(provider, target);
    if (volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length !== 0)
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const owner = volume.Labels?.["dev.lando.volume-owner"];
    if (owner !== undefined && owner !== target.ownerRoot)
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    if (owner && volume.Labels?.["dev.lando.volume-instance"]) {
      const observed = yield* observeMountedVolume(provider, target);
      if (!observed.identity || observed.identity.ownerRoot !== target.ownerRoot)
        return yield* Effect.fail(volumeObservationFailure(provider.providerId));
      return observed;
    }
    const key = yield* volumeCoordinationKey(provider, volume.Name);
    if (!key) return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const witness = yield* adoptNativeVolumeWitness(provider, volume, target);
    if (!witness || witness.ownerRoot !== target.ownerRoot)
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const current = yield* resolveMountedVolume(provider, target);
    if (
      current.Labels?.["dev.lando.volume-owner"] !== undefined &&
      current.Labels["dev.lando.volume-owner"] !== target.ownerRoot
    )
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    if (
      current.Name !== volume.Name ||
      current.Driver !== "local" ||
      Object.keys(current.Options ?? {}).length !== 0 ||
      (yield* volumeCoordinationKey(provider, current.Name)) !== key
    )
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    const resolution = yield* resolveNativeVolumeIdentity(provider, current, { _tag: "mounted", target });
    const identity = resolution.identity;
    if (
      identity === undefined ||
      identity.origin !== "adopted" ||
      identity.generation !== witness.generation ||
      identity.ownerRoot !== target.ownerRoot
    )
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    return {
      ...volumeInfo(target, current),
      identity,
    };
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId, "adoptVolume")));
