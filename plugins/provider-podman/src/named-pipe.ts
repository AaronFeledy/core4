import { createConnection } from "node:net";
import {
  ContainerTransportError,
  type SocketHttpConnection,
  connectSocket,
  decodeChunkedBody,
  flushChunkedBufferAtEnd,
  makeSocketHttpClient,
  normalizeNamedPipePath,
} from "@lando/container-runtime/transport";
import { Effect, Stream } from "effect";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "@lando/provider-lando";
import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

const PROVIDER_ID = "podman";

export { decodeChunkedBody, flushChunkedBufferAtEnd };

const unavailable = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const internal = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

export const connectNamedPipeSocket = connectSocket;

const transportFailure = (cause: ContainerTransportError): ProviderUnavailableError | ProviderInternalError =>
  cause.kind === "parse"
    ? internal("podman-api", cause.message, cause.details, cause)
    : unavailable("podman-api", cause.message, cause.details, cause);

const podmanApiFailure = (
  request: PodmanHttpRequest,
  cause: unknown,
): ProviderUnavailableError | ProviderInternalError => {
  if (cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError) return cause;
  if (cause instanceof ContainerTransportError) return transportFailure(cause);
  return unavailable(
    "podman-api",
    "Failed to call the Podman API.",
    { method: request.method, path: request.path },
    cause,
  );
};

export const namedPipeInfoFailure = (cause: unknown): ProviderCapabilityError | ProviderUnavailableError => {
  const infoRequest: PodmanHttpRequest = { method: "GET", path: "/libpod/info" };
  const failure = podmanApiFailure(infoRequest, cause);
  return failure instanceof ProviderUnavailableError
    ? failure
    : new ProviderCapabilityError({
        providerId: PROVIDER_ID,
        operation: "capabilities",
        message: "Failed to inspect provider-podman capabilities through the Podman API.",
        capability: "podman-info",
        requiredValue: "Podman HTTP API info response",
        actualValue: undefined,
        cause: failure,
      });
};

export const npipeSocketPath = normalizeNamedPipePath;

const makeNamedPipeClient = (pipePath: string) =>
  makeSocketHttpClient({
    apiPrefix: "/v5.0.0",
    operation: "podman-api",
    connect: async () => {
      const socket = createConnection({ path: pipePath });
      await connectNamedPipeSocket(socket);
      return socket as unknown as SocketHttpConnection;
    },
  });

export const makeNamedPipePodmanApiClient = (socketPath: string): PodmanApiClient => {
  const pipePath = npipeSocketPath(socketPath);
  const client = makeNamedPipeClient(pipePath);
  return {
    stream: (request) =>
      Stream.fromAsyncIterable(client.stream(request), (cause) => podmanApiFailure(request, cause)),
    request: (request) =>
      Effect.tryPromise({
        try: () => client.request(request) as Promise<PodmanHttpResponse>,
        catch: (cause) => podmanApiFailure(request, cause),
      }),
    info: Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => client.request({ method: "GET", path: "/libpod/info" }) as Promise<PodmanHttpResponse>,
        catch: namedPipeInfoFailure,
      });
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.fail(
          unavailable("capabilities", `Podman info failed with HTTP ${response.status}.`, response),
        );
      }
      return yield* Effect.try({
        try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
        catch: (cause) =>
          new ProviderCapabilityError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: "Podman API returned malformed JSON — could not parse info response.",
            capability: "podman-info",
            requiredValue: "valid JSON Podman API info response",
            actualValue: response.body,
            cause,
          }),
      });
    }),
  };
};
