import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";

import { VolumeOperationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppId,
  type AppIdentity,
  type PortablePath,
  VolumeIdentity,
  type VolumeInfo,
  VolumeLocator,
  type VolumeRef,
} from "@lando/sdk/schema";
import type { ExecResult, ProviderError } from "@lando/sdk/services";

import type { DataPlaneApiClient } from "./data-plane.ts";
import { volumeWitnessCommand } from "./volume-witness-helper.ts";

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
const Volume = Schema.Struct({
  Name: Schema.NonEmptyString,
  Driver: Schema.optional(Schema.String),
  Options: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String }))),
  Labels: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String }))),
});

export interface VolumeObservationProvider {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly endpointNamespace?: string;
  readonly runWitness?: (
    target: MountedVolumeTarget,
    command: readonly string[],
  ) => Effect.Effect<ExecResult, ProviderError>;
}

export interface MountedVolumeTarget {
  readonly app: AppId;
  readonly containerId: string;
  readonly destination: PortablePath;
}

export interface VolumeAdoptionTarget extends MountedVolumeTarget {
  readonly ownerRoot: AbsolutePath;
}

const Witness = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.UUID,
  ownerRoot: AbsolutePath,
});

const failure = (providerId: string, operation = "observeVolume") =>
  new VolumeOperationError({
    providerId,
    operation,
    message: "The provider could not prove the named volume mounted at the requested destination.",
    remediation:
      "Inspect the existing container and its mounts; do not mutate a volume inferred from the app name.",
  });

const resolveMountedVolume = (provider: VolumeObservationProvider, target: MountedVolumeTarget) =>
  Effect.gen(function* () {
    const request = provider.api.request;
    if (request === undefined) return yield* Effect.fail(failure(provider.providerId));
    const containerResponse = yield* request({
      method: "GET",
      path: `/containers/${encodeURIComponent(target.containerId)}/json`,
    });
    if (containerResponse.status !== 200) return yield* Effect.fail(failure(provider.providerId));
    const container = yield* Schema.decodeUnknown(Schema.parseJson(Container))(containerResponse.body);
    const matches = container.Mounts.filter((mount) => mount.Destination === target.destination);
    const mount = matches[0];
    if (matches.length !== 1 || mount?.Type !== "volume" || !mount.Name) {
      return yield* Effect.fail(failure(provider.providerId));
    }
    const response = yield* request({ method: "GET", path: `/volumes/${encodeURIComponent(mount.Name)}` });
    if (response.status !== 200) return yield* Effect.fail(failure(provider.providerId));
    const volume = yield* Schema.decodeUnknown(Schema.parseJson(Volume))(response.body);
    if (volume.Name !== mount.Name) return yield* Effect.fail(failure(provider.providerId));
    return volume;
  }).pipe(Effect.mapError(() => failure(provider.providerId)));

const coordinationKey = (provider: VolumeObservationProvider, name: string) =>
  Effect.gen(function* () {
    if (provider.endpointNamespace) return JSON.stringify([`endpoint:${provider.endpointNamespace}`, name]);
    const request = provider.api.request;
    if (request) {
      const info = yield* request({ method: "GET", path: "/info" });
      if (info.status === 200) {
        const daemon = yield* Schema.decodeUnknown(
          Schema.parseJson(Schema.Struct({ ID: Schema.optional(Schema.NonEmptyString) })),
        )(info.body);
        if (daemon.ID) return JSON.stringify([daemon.ID, name]);
      }
    }
    return undefined;
  }).pipe(Effect.mapError(() => failure(provider.providerId)));

export const locateVolume = (
  provider: VolumeObservationProvider,
  ref: VolumeRef,
): Effect.Effect<typeof VolumeLocator.Type, VolumeOperationError> =>
  Effect.gen(function* () {
    const endpointNamespace = provider.endpointNamespace;
    const request = provider.api.request;
    if (endpointNamespace === undefined || request === undefined) {
      return yield* Effect.fail(failure(provider.providerId, "locateVolume"));
    }
    const key = JSON.stringify([`endpoint:${endpointNamespace}`, ref.store]);
    const response = yield* request({ method: "GET", path: `/volumes/${encodeURIComponent(ref.store)}` });
    if (response.status === 404) {
      return yield* Schema.decodeUnknown(VolumeLocator)({ coordinationKey: key, nativeName: ref.store });
    }
    if (response.status !== 200) return yield* Effect.fail(failure(provider.providerId, "locateVolume"));
    const volume = yield* Schema.decodeUnknown(Schema.parseJson(Volume))(response.body);
    if (volume.Name !== ref.store) return yield* Effect.fail(failure(provider.providerId, "locateVolume"));
    const generation = volume.Labels?.["dev.lando.volume-instance"];
    const ownerRoot = volume.Labels?.["dev.lando.volume-owner"];
    return yield* Schema.decodeUnknown(VolumeLocator)({
      coordinationKey: key,
      nativeName: volume.Name,
      ...(generation === undefined || ownerRoot === undefined
        ? {}
        : {
            identity: {
              coordinationKey: key,
              nativeName: volume.Name,
              generation,
              ownerRoot,
              origin: "created",
            },
          }),
    });
  }).pipe(Effect.mapError(() => failure(provider.providerId, "locateVolume")));

const runWitness = (
  provider: VolumeObservationProvider,
  target: MountedVolumeTarget,
  ownerRoot?: AbsolutePath,
) =>
  Effect.gen(function* () {
    if (!provider.runWitness) return yield* Effect.fail(failure(provider.providerId));
    const result = yield* provider.runWitness(
      target,
      volumeWitnessCommand({
        root: target.destination,
        ...(ownerRoot === undefined
          ? { operation: "read" as const }
          : { operation: "adopt" as const, ownerRoot, generation: randomUUID() }),
      }),
    );
    if (result.exitCode !== 0 || result.stdout.length > 8192)
      return yield* Effect.fail(failure(provider.providerId));
    return yield* Schema.decodeUnknown(Schema.parseJson(Schema.NullOr(Witness)))(result.stdout);
  }).pipe(Effect.mapError(() => failure(provider.providerId)));

const supportsWitness = (volume: typeof Volume.Type) =>
  volume.Driver === "local" && Object.keys(volume.Options ?? {}).length === 0;

const volumeInfo = (target: MountedVolumeTarget, volume: typeof Volume.Type): VolumeInfo => {
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
    const generation = volume.Labels?.["dev.lando.volume-instance"];
    const ownerRoot = volume.Labels?.["dev.lando.volume-owner"];
    if (generation && ownerRoot) {
      const key = yield* coordinationKey(provider, volume.Name);
      if (!key) return base;
      const identity = yield* Schema.decodeUnknown(VolumeIdentity)({
        coordinationKey: key,
        nativeName: volume.Name,
        generation,
        ownerRoot,
        origin: "created",
      });
      return { ...base, identity };
    }
    if (!provider.runWitness || !supportsWitness(volume)) return base;
    const key = yield* coordinationKey(provider, volume.Name);
    if (!key) return base;
    const witness = yield* runWitness(provider, target);
    if (!witness) return base;
    return {
      ...base,
      identity: {
        coordinationKey: key,
        nativeName: volume.Name,
        generation: witness.generation,
        ownerRoot: witness.ownerRoot,
        origin: "adopted" as const,
      },
    };
  }).pipe(Effect.mapError(() => failure(provider.providerId)));

export const adoptMountedVolume = (
  provider: VolumeObservationProvider,
  target: VolumeAdoptionTarget,
): Effect.Effect<VolumeInfo, VolumeOperationError> =>
  Effect.gen(function* () {
    const volume = yield* resolveMountedVolume(provider, target);
    if (!supportsWitness(volume)) return yield* Effect.fail(failure(provider.providerId));
    const owner = volume.Labels?.["dev.lando.volume-owner"];
    if (owner !== undefined && owner !== target.ownerRoot)
      return yield* Effect.fail(failure(provider.providerId));
    if (owner && volume.Labels?.["dev.lando.volume-instance"]) {
      const observed = yield* observeMountedVolume(provider, target);
      if (!observed.identity || observed.identity.ownerRoot !== target.ownerRoot)
        return yield* Effect.fail(failure(provider.providerId));
      return observed;
    }
    const key = yield* coordinationKey(provider, volume.Name);
    if (!key) return yield* Effect.fail(failure(provider.providerId));
    const witness = yield* runWitness(provider, target, target.ownerRoot);
    if (!witness || witness.ownerRoot !== target.ownerRoot)
      return yield* Effect.fail(failure(provider.providerId));
    const current = yield* resolveMountedVolume(provider, target);
    if (
      current.Labels?.["dev.lando.volume-owner"] !== undefined &&
      current.Labels["dev.lando.volume-owner"] !== target.ownerRoot
    )
      return yield* Effect.fail(failure(provider.providerId));
    if (
      current.Name !== volume.Name ||
      !supportsWitness(current) ||
      (yield* coordinationKey(provider, current.Name)) !== key
    )
      return yield* Effect.fail(failure(provider.providerId));
    const reread = yield* runWitness(provider, target);
    if (!reread || reread.generation !== witness.generation || reread.ownerRoot !== target.ownerRoot)
      return yield* Effect.fail(failure(provider.providerId));
    return {
      ...volumeInfo(target, current),
      identity: {
        coordinationKey: key,
        nativeName: current.Name,
        generation: reread.generation,
        ownerRoot: reread.ownerRoot,
        origin: "adopted" as const,
      },
    };
  }).pipe(Effect.mapError(() => failure(provider.providerId, "adoptVolume")));
