import { createConnection } from "node:net";

import {
  connectSocket,
  makeSocketHttpClient,
  normalizeNamedPipePath,
} from "@lando/container-runtime/transport";
import { Effect, Stream } from "effect";

import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanApiClient, PodmanHttpRequest } from "./capabilities.ts";
import { redactDetails } from "./redact.ts";

const PROVIDER_ID = "lando";
const TRANSPORT_REMEDIATION =
  "Run `lando doctor` to inspect the Lando runtime, then retry the failing command. Run `lando setup` if the runtime is not installed or healthy.";

const podmanApiFailure = (
  request: PodmanHttpRequest,
  cause: unknown,
): ProviderUnavailableError | ProviderInternalError =>
  cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
    ? cause
    : new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: "podman-api",
        message: "Failed to call the Podman API.",
        details: redactDetails({ method: request.method, path: request.path }),
        remediation: TRANSPORT_REMEDIATION,
        cause: redactDetails(cause),
      });

const makePodmanSocketClient = (socketPath: string) =>
  makeSocketHttpClient({
    apiPrefix: "/v6.0.0",
    operation: "podman-api",
    connect: async () => {
      const socket = createConnection({ path: normalizeNamedPipePath(socketPath) });
      await connectSocket(socket);
      return {
        [Symbol.asyncIterator]: () => socket[Symbol.asyncIterator](),
        write: (data) => {
          socket.write(data);
        },
        destroy: () => {
          socket.destroy();
        },
      };
    },
  });

export const isNamedPipeEndpoint = (socketPath: string): boolean =>
  socketPath.startsWith("npipe:") || socketPath.startsWith("\\\\.\\pipe\\");

export const streamPodmanApiRequest = (
  socketPath: string,
  request: PodmanHttpRequest,
): Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError> =>
  Stream.fromAsyncIterable(makePodmanSocketClient(socketPath).stream(request), (cause) =>
    podmanApiFailure(request, cause),
  );

export const makeNamedPipePodmanApiClient = (socketPath: string): PodmanApiClient => {
  const client = makePodmanSocketClient(socketPath);
  const request = (input: PodmanHttpRequest) =>
    Effect.tryPromise({
      try: () => client.request(input),
      catch: (cause) => podmanApiFailure(input, cause),
    });
  const capabilityRequest = (input: PodmanHttpRequest, capability: string, requiredValue: string) =>
    Effect.tryPromise({
      try: () => client.request(input),
      catch: (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "Failed to inspect provider-lando capabilities through the Podman API.",
          capability,
          requiredValue,
          actualValue: undefined,
          cause,
        }),
    });
  return {
    stream: (input) => streamPodmanApiRequest(socketPath, input),
    request,
    info: Effect.gen(function* () {
      const response = yield* capabilityRequest(
        { method: "GET", path: "/libpod/info" },
        "podman-info",
        "Podman HTTP API info response",
      );
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: `Podman API info request failed with HTTP ${response.status}.`,
            remediation: TRANSPORT_REMEDIATION,
          }),
        );
      }
      return yield* Effect.try({
        try: (): unknown => JSON.parse(response.body),
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
    ping: Effect.gen(function* () {
      const response = yield* capabilityRequest(
        { method: "GET", path: "/libpod/_ping" },
        "podman-ping",
        "Podman HTTP API ping response",
      );
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: `Podman API ping request failed with HTTP ${response.status}.`,
            remediation: TRANSPORT_REMEDIATION,
          }),
        );
      }
    }),
  };
};
