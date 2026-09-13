import { Effect, Schema } from "effect";

import { VolumeOperationError } from "@lando/sdk/errors";
import {
  type AppId,
  type AppIdentity,
  type PortablePath,
  VolumeIdentity,
  type VolumeInfo,
} from "@lando/sdk/schema";

import type { DataPlaneApiClient } from "./data-plane.ts";

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
  Labels: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String }))),
});

export interface VolumeObservationProvider {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
}

export interface MountedVolumeTarget {
  readonly app: AppId;
  readonly containerId: string;
  readonly destination: PortablePath;
}

const failure = (providerId: string) =>
  new VolumeOperationError({
    providerId,
    operation: "observeVolume",
    message: "The provider could not prove the named volume mounted at the requested destination.",
    remediation:
      "Inspect the existing container and its mounts; do not mutate a volume inferred from the app name.",
  });

export const observeMountedVolume = (
  provider: VolumeObservationProvider,
  target: MountedVolumeTarget,
): Effect.Effect<VolumeInfo, VolumeOperationError> =>
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
    const instanceId = volume.Labels?.["dev.lando.volume-instance"];
    const ownerRoot = volume.Labels?.["dev.lando.volume-owner"];
    let identity: VolumeIdentity | undefined;
    if (instanceId && ownerRoot) {
      const info = yield* request({ method: "GET", path: "/info" });
      if (info.status === 200) {
        const daemon = yield* Schema.decodeUnknown(
          Schema.parseJson(Schema.Struct({ ID: Schema.optional(Schema.NonEmptyString) })),
        )(info.body);
        if (daemon.ID)
          identity = yield* Schema.decodeUnknown(VolumeIdentity)({
            coordinationKey: JSON.stringify([daemon.ID, volume.Name]),
            nativeName: volume.Name,
            generation: instanceId,
            ownerRoot,
            origin: "created",
          });
      }
    }
    return {
      ref: { app: target.app, store: volume.Name },
      ...(identity === undefined ? {} : { identity }),
      ...(instanceId ? { instanceId, provenance: "known" as const } : { provenance: "legacy" as const }),
      ...(volume.Labels == null ? {} : { labels: volume.Labels }),
    } satisfies VolumeInfo;
  }).pipe(Effect.mapError(() => failure(provider.providerId)));
