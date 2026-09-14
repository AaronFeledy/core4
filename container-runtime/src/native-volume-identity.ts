import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";

import { VolumeOperationError } from "@lando/sdk/errors";
import { AbsolutePath, type AppId, type PortablePath, VolumeIdentity } from "@lando/sdk/schema";
import type { ExecResult, ProviderError } from "@lando/sdk/services";

import type { DataPlaneApiClient } from "./data-plane.ts";
import { VOLUME_WITNESS_MOUNT, volumeWitnessCommand } from "./volume-witness-helper.ts";

export const NativeVolumeSchema = Schema.Struct({
  Name: Schema.NonEmptyString,
  Driver: Schema.optional(Schema.String),
  Options: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String }))),
  Labels: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String }))),
});

export type NativeVolume = typeof NativeVolumeSchema.Type;

export interface MountedVolumeTarget {
  readonly app: AppId;
  readonly containerId: string;
  readonly destination: PortablePath;
}

export interface VolumeAdoptionTarget extends MountedVolumeTarget {
  readonly ownerRoot: AbsolutePath;
}

export interface VolumeObservationProvider {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly endpointNamespace?: string;
  readonly runWitness?: (
    target: MountedVolumeTarget,
    command: readonly string[],
    readOnly: boolean,
  ) => Effect.Effect<ExecResult, ProviderError>;
  readonly runVolumeWitness?: (
    nativeName: string,
    command: readonly string[],
  ) => Effect.Effect<ExecResult, ProviderError>;
}

export interface NativeVolumeIdentityResolution {
  readonly creationGeneration?: string;
  readonly identity?: typeof VolumeIdentity.Type;
}

type WitnessTarget =
  | { readonly _tag: "mounted"; readonly target: MountedVolumeTarget }
  | { readonly _tag: "named" };

const Witness = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.UUID,
  ownerRoot: AbsolutePath,
});

export const volumeObservationFailure = (providerId: string, operation = "observeVolume") =>
  new VolumeOperationError({
    providerId,
    operation,
    message: "The provider could not prove the named volume mounted at the requested destination.",
    remediation:
      "Inspect the existing container and its mounts; do not mutate a volume inferred from the app name.",
  });

export const volumeCoordinationKey = (provider: VolumeObservationProvider, name: string) =>
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
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId)));

const runWitness = (
  provider: VolumeObservationProvider,
  volume: NativeVolume,
  witnessTarget: WitnessTarget,
  ownerRoot?: AbsolutePath,
) =>
  Effect.gen(function* () {
    const command = volumeWitnessCommand({
      root: witnessTarget._tag === "mounted" ? witnessTarget.target.destination : VOLUME_WITNESS_MOUNT,
      ...(ownerRoot === undefined
        ? { operation: "read" as const }
        : { operation: "adopt" as const, ownerRoot, generation: randomUUID() }),
    });
    const result =
      witnessTarget._tag === "mounted"
        ? yield* provider.runWitness?.(witnessTarget.target, command, ownerRoot === undefined) ??
            Effect.fail(volumeObservationFailure(provider.providerId))
        : yield* provider.runVolumeWitness?.(volume.Name, command) ??
            Effect.fail(volumeObservationFailure(provider.providerId));
    if (result.exitCode !== 0 || result.stdout.length > 8192) {
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    }
    return yield* Schema.decodeUnknown(Schema.parseJson(Schema.NullOr(Witness)))(result.stdout);
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId)));

const supportsWitness = (volume: NativeVolume) =>
  volume.Driver === "local" && Object.keys(volume.Options ?? {}).length === 0;

export const resolveNativeVolumeIdentity = (
  provider: VolumeObservationProvider,
  volume: NativeVolume,
  witnessTarget?: WitnessTarget,
): Effect.Effect<NativeVolumeIdentityResolution, VolumeOperationError> =>
  Effect.gen(function* () {
    const generation = volume.Labels?.["dev.lando.volume-instance"];
    const ownerRoot = volume.Labels?.["dev.lando.volume-owner"];
    if (generation !== undefined && ownerRoot !== undefined) {
      const key = yield* volumeCoordinationKey(provider, volume.Name);
      return {
        creationGeneration: generation,
        ...(key === undefined
          ? {}
          : {
              identity: yield* Schema.decodeUnknown(VolumeIdentity)({
                coordinationKey: key,
                nativeName: volume.Name,
                generation,
                ownerRoot,
                origin: "created",
              }),
            }),
      };
    }
    if (witnessTarget === undefined || !supportsWitness(volume)) {
      return generation === undefined ? {} : { creationGeneration: generation };
    }
    const witness = yield* runWitness(provider, volume, witnessTarget);
    if (witness === null) return generation === undefined ? {} : { creationGeneration: generation };
    if (ownerRoot !== undefined && ownerRoot !== witness.ownerRoot) {
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    }
    if (generation !== undefined && generation !== witness.generation) {
      return yield* Effect.fail(volumeObservationFailure(provider.providerId));
    }
    const key = yield* volumeCoordinationKey(provider, volume.Name);
    return {
      ...(generation === undefined ? {} : { creationGeneration: generation }),
      ...(key === undefined
        ? {}
        : {
            identity: yield* Schema.decodeUnknown(VolumeIdentity)({
              coordinationKey: key,
              nativeName: volume.Name,
              generation: witness.generation,
              ownerRoot: witness.ownerRoot,
              origin: "adopted",
            }),
          }),
    };
  }).pipe(Effect.mapError(() => volumeObservationFailure(provider.providerId)));

export const adoptNativeVolumeWitness = (
  provider: VolumeObservationProvider,
  volume: NativeVolume,
  target: VolumeAdoptionTarget,
) => runWitness(provider, volume, { _tag: "mounted", target }, target.ownerRoot);
