import { Context, type Effect, type Schema, type Scope } from "effect";

import type {
  DatasetApplyError,
  DatasetBindingError,
  DatasetCaptureError,
  DatasetError,
  RemoteAuthError,
  RemoteDatasetUnsupportedError,
  RemoteEnvNotFoundError,
  RemoteError,
  RemoteProtectedEnvError,
  RemoteProviderUnavailableError,
  RemoteToolMissingError,
  RemoteUnreachableError,
} from "../errors/index.ts";
import type {
  DataEndpoint,
  DatasetApplyOptions,
  DatasetApplyResult,
  DatasetArtifactFormat,
  DatasetCapabilities,
  DatasetCaptureOptions,
  DatasetContext,
  DatasetKind,
  RemoteCapabilities,
  RemoteConfig,
  RemoteEnvId,
  RemoteEnvironment,
  RemoteFetchOptions,
  RemoteLocator,
  RemoteSendOptions,
  RemoteTestResult,
  VolumeRef,
} from "../schema/index.ts";

export type RemoteSourceError =
  | RemoteError
  | RemoteUnreachableError
  | RemoteAuthError
  | RemoteEnvNotFoundError
  | RemoteDatasetUnsupportedError
  | RemoteProviderUnavailableError
  | RemoteProtectedEnvError
  | RemoteToolMissingError;

export type DatasetServiceError =
  | DatasetError
  | DatasetCaptureError
  | DatasetApplyError
  | DatasetBindingError;

export interface RemoteSourceShape {
  readonly id: string;
  readonly capabilities: RemoteCapabilities;
  readonly configSchema: Schema.Schema<unknown>;
  readonly listEnvironments: (
    cfg: RemoteConfig,
  ) => Effect.Effect<ReadonlyArray<RemoteEnvironment>, RemoteSourceError>;
  readonly resolve: (
    cfg: RemoteConfig,
    env: RemoteEnvId,
    datasetId: string,
  ) => Effect.Effect<RemoteLocator, RemoteSourceError>;
  readonly fetch: (
    locator: RemoteLocator,
    opts?: RemoteFetchOptions,
  ) => Effect.Effect<DataEndpoint, RemoteSourceError, Scope.Scope>;
  readonly send: (
    locator: RemoteLocator,
    artifact: DataEndpoint,
    opts?: RemoteSendOptions,
  ) => Effect.Effect<void, RemoteSourceError, Scope.Scope>;
  readonly test?: (
    cfg: RemoteConfig,
    env?: RemoteEnvId,
  ) => Effect.Effect<RemoteTestResult, RemoteSourceError>;
}

export interface DatasetShape {
  readonly id: string;
  readonly kind: DatasetKind;
  readonly capabilities: DatasetCapabilities;
  readonly artifactFormat: DatasetArtifactFormat;
  readonly capture: (
    ctx: DatasetContext,
    opts?: DatasetCaptureOptions,
  ) => Effect.Effect<DataEndpoint, DatasetServiceError, Scope.Scope>;
  readonly apply: (
    ctx: DatasetContext,
    artifact: DataEndpoint,
    opts?: DatasetApplyOptions,
  ) => Effect.Effect<DatasetApplyResult, DatasetServiceError, Scope.Scope>;
  readonly localStore: (ctx: DatasetContext) => Effect.Effect<VolumeRef | null, DatasetServiceError>;
}

export class RemoteSource extends Context.Tag("@lando/core/RemoteSource")<
  RemoteSource,
  RemoteSourceShape
>() {}

export class Dataset extends Context.Tag("@lando/core/Dataset")<Dataset, DatasetShape>() {}
