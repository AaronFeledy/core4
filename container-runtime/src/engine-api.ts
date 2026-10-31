import type { Redactor } from "@lando/sdk/secrets";
import type { Effect, Stream } from "effect";

import type {
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";

export type ProviderErrorContext = {
  readonly providerId: string;
  readonly remediation: string;
  /** Explicit host env snapshot for heuristic secret collection. Never read process.env here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly redactor?: Redactor;
};

export interface EngineHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  /** Docker-only feature API: volume subpaths (1.45) require advertised support; optional gateway priority (1.48) may fall back. Ordinary requests keep their negotiated prefix. */
  readonly minimumApiVersion?: "1.45" | "1.48";
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
  /** Called after successful stream response headers arrive, before body bytes are emitted. */
  readonly onResponseHead?: () => void;
}

export interface EngineHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Compat removal deletes engine-anonymous volumes, never explicitly named mounts. */
export const buildContainerRemoveRequest = (rawReference: string): EngineHttpRequest => ({
  method: "DELETE",
  path: `/containers/${encodeURIComponent(rawReference)}?force=true&v=true`,
});

export interface EngineHttpApi {
  /** Named-pipe exec attach can stay open after Podman reports command exit. */
  readonly execAttachNeedsInspectCompletion?: boolean;
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

export const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;
