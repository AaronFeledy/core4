import type { Effect, Stream } from "effect";

import type {
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";

export type ProviderErrorContext = {
  readonly providerId: string;
  readonly remediation: string;
};

export interface EngineHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface EngineHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface EngineHttpApi {
  readonly request?: (
    request: EngineHttpRequest,
  ) => Effect.Effect<EngineHttpResponse, ProviderUnavailableError | ProviderInternalError>;
  readonly stream?: (
    request: EngineHttpRequest,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>;
}

type EngineInfoError = ProviderCapabilityError | ProviderUnavailableError | ProviderInternalError;

export interface EngineApiClient extends EngineHttpApi {
  // Docker transport parsing can fail internally before capability introspection normalizes it.
  readonly info: Effect.Effect<unknown, EngineInfoError>;
}

export interface PodmanApiClient extends EngineApiClient {
  readonly ping: Effect.Effect<void, EngineInfoError>;
}

export type PodmanHttpRequest = EngineHttpRequest;
export type PodmanHttpResponse = EngineHttpResponse;
export type DockerApiClient = EngineApiClient;
export type DockerHttpRequest = EngineHttpRequest;
export type DockerHttpResponse = EngineHttpResponse;

export const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;
